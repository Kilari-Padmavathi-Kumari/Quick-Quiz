import { API_URL, DEFAULT_ORGANIZATION_ID } from "./config";
import { clearStoredSession, updateStoredAccessToken } from "./session";

export type PrizeRule = "all_correct" | "top_scorer";

export interface LoginResponse {
  access_token: string;
  user: {
    id: string;
    email: string;
    name: string;
    avatar_url?: string | null;
    wallet_balance: string;
    is_admin: boolean;
  };
}

const UUID_PATTERN =
  /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;

function getConfiguredOrganizationId() {
  if (!DEFAULT_ORGANIZATION_ID || !UUID_PATTERN.test(DEFAULT_ORGANIZATION_ID)) {
    throw new Error("Missing valid NEXT_PUBLIC_ORGANIZATION_ID for tenant-scoped requests.");
  }

  return DEFAULT_ORGANIZATION_ID;
}

function resolveOrganizationIdFromToken(token: string) {
  if (typeof window === "undefined") {
    throw new Error("Cannot resolve tenant context outside the browser.");
  }

  const payload = token.split(".")[1];
  if (!payload) {
    throw new Error("Access token is missing tenant context.");
  }

  const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
  const decoded = window.atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  const parsed = JSON.parse(decoded) as { organization_id?: string };

  if (!parsed.organization_id || !UUID_PATTERN.test(parsed.organization_id)) {
    throw new Error("Access token organization is missing or invalid.");
  }

  return parsed.organization_id;
}

async function apiFetch<T>(path: string, init?: RequestInit, accessToken?: string): Promise<T> {
  const buildRequest = (token?: string) => ({
    ...init,
    headers: {
      "content-type": "application/json",
      "x-organization-id": token ? resolveOrganizationIdFromToken(token) : getConfiguredOrganizationId(),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {})
    },
    credentials: "include" as const,
    cache: "no-store" as const
  });

  let response: Response;

  try {
    response = await fetch(`${API_URL}${path}`, buildRequest(accessToken));
  } catch (error) {
    console.error("[frontend] API request failed to reach server", {
      path,
      method: init?.method ?? "GET",
      error
    });
    throw new Error(
      "Failed to reach the API server. Make sure `pnpm dev:api` is running and `NEXT_PUBLIC_API_URL` matches it."
    );
  }

  if (response.status === 401 && accessToken) {
    const refreshedToken = await refreshAccessToken();

    if (refreshedToken) {
      response = await fetch(`${API_URL}${path}`, buildRequest(refreshedToken));
    }
  }

  if (!response.ok) {
    let message = `Request failed with ${response.status}`;

    try {
      const errorBody = (await response.json()) as { message?: string };
      if (errorBody.message) {
        message = errorBody.message;
      }
    } catch {
      // ignore
    }

    console.error("[frontend] API request returned an error response", {
      path,
      method: init?.method ?? "GET",
      status: response.status,
      message
    });

    throw new Error(message);
  }

  return (await response.json()) as T;
}

async function refreshAccessToken() {
  try {
    const response = await fetch(`${API_URL}/auth/refresh`, {
      method: "POST",
      credentials: "include",
      cache: "no-store"
    });

    if (!response.ok) {
      console.error("[frontend] Access token refresh failed", {
        status: response.status
      });
      clearStoredSession();
      window.dispatchEvent(new Event("quiz-app-session-expired"));
      return null;
    }

    const body = (await response.json()) as { access_token: string };
    updateStoredAccessToken(body.access_token);
    return body.access_token;
  } catch (error) {
    console.error("[frontend] Access token refresh request crashed", error);
    return null;
  }
}

export function logout() {
  return apiFetch<{ success: boolean }>(
    "/auth/logout",
    {
      method: "POST",
      body: JSON.stringify({})
    }
  );
}

export function requestLoginCode(payload: { email: string; name?: string; avatar_url?: string }) {
  return apiFetch<{
    success: boolean;
    email: string;
    expires_in_minutes: number;
    dev_code?: string;
  }>("/auth/request-code", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function loginWithEmailOnly(payload: { email: string; name?: string; avatar_url?: string }) {
  return apiFetch<LoginResponse>("/auth/email-login", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function verifyLoginCode(payload: { email: string; code: string }) {
  return apiFetch<LoginResponse>("/auth/verify-code", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function loginWithPassword(payload: {
  email: string;
  password: string;
  name?: string;
  avatar_url?: string;
}) {
  return apiFetch<LoginResponse>("/auth/password-login", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function loginWithGoogleToken(idToken: string) {
  return apiFetch<LoginResponse>("/auth/google", {
    method: "POST",
    body: JSON.stringify({ id_token: idToken })
  });
}

export function getWalletBalance(accessToken: string) {
  return apiFetch<{ wallet_balance: string }>("/wallet/balance", undefined, accessToken);
}

export function getWalletTransactions(accessToken: string) {
  return apiFetch<{
    transactions: Array<{
      id: string;
      type: "credit" | "debit";
      reason: "entry_fee" | "prize" | "refund" | "topup" | "manual_topup";
      amount: string;
      balance_before: string;
      balance_after: string;
      reference_id: string | null;
      metadata?: {
        contestId?: string;
        contestTitle?: string;
        source?: string;
      };
      created_at: string;
    }>;
  }>("/wallet/transactions", undefined, accessToken);
}

export function getWalletRequests(accessToken: string) {
  return apiFetch<{
    requests: Array<{
      id: string;
      amount: string;
      status: "pending" | "approved" | "rejected";
      requested_at: string;
      reviewed_at: string | null;
    }>;
  }>("/wallet/requests", undefined, accessToken);
}

export function requestMoney(accessToken: string, amount: number) {
  return apiFetch<{
    success: boolean;
    request: {
      id: string;
      amount: string;
      status: "pending";
      requested_at: string;
      reviewed_at: string | null;
    };
  }>(
    "/wallet/request-money",
    {
      method: "POST",
      body: JSON.stringify({ amount })
    },
    accessToken
  );
}

export function getOpenContests() {
  return apiFetch<{
    contests: Array<{
      id: string;
      title: string;
      entry_fee: string;
      max_members: number;
      member_count: number;
      starts_at: string;
      prize_pool: string;
      prize_rule: PrizeRule;
    }>;
  }>("/contests");
}

export function getAllContests() {
  return apiFetch<{
    contests: Array<{
      id: string;
      title: string;
      status: string;
      entry_fee: string;
      max_members: number;
      member_count: number;
      starts_at: string;
      prize_pool: string;
      prize_rule: PrizeRule;
    }>;
  }>("/contests/all");
}

export function getContestHistory(accessToken: string) {
  return apiFetch<{
    contests: Array<{
      contest_id: string;
      title: string;
      status: string;
      entry_fee: string;
      member_count: number;
      max_members: number;
      starts_at: string;
      joined_at: string;
      is_winner: boolean;
      prize_amount: string;
      correct_count: string;
      prize_pool: string;
      prize_rule: PrizeRule;
    }>;
  }>("/contests/history", undefined, accessToken);
}

export function joinContest(accessToken: string, contestId: string) {
  return apiFetch<{
    success: boolean;
    contest_id: string;
    member_count: number;
    prize_pool: string;
    wallet_balance: string;
  }>(
    `/contests/${contestId}/join`,
    {
      method: "POST",
      body: JSON.stringify({})
    },
    accessToken
  );
}

export function getLeaderboard(contestId: string) {
  return apiFetch<{
    contest: {
      id: string;
      title: string;
      prize_rule: PrizeRule;
    };
    leaderboard: Array<{
      user_id: string;
      name: string;
      avatar_url: string | null;
      correct_count: string;
      is_winner: boolean;
      prize_amount: string;
    }>;
  }>(`/contests/${contestId}/leaderboard`);
}

export function getAdminContests(accessToken: string) {
  return apiFetch<{
    contests: Array<{
      id: string;
      title: string;
      status: string;
      member_count: number;
      starts_at: string;
      prize_pool: string;
    }>;
  }>("/admin/contests", undefined, accessToken);
}

export function createContest(
  accessToken: string,
  payload: {
    title: string;
    starts_at: string;
    entry_fee: number;
    max_members: number;
    prize_rule: PrizeRule;
  }
) {
  return apiFetch<{ contest: { id: string } }>(
    "/admin/contests",
    {
      method: "POST",
      body: JSON.stringify(payload)
    },
    accessToken
  );
}

export function addQuestion(
  accessToken: string,
  contestId: string,
  payload: {
    seq: number;
    body: string;
    option_a: string;
    option_b: string;
    option_c: string;
    option_d: string;
    correct_option: "a" | "b" | "c" | "d";
    time_limit_sec: number;
  }
) {
  return apiFetch<{ question: { id: string; seq: number } }>(
    `/admin/contests/${contestId}/questions`,
    {
      method: "POST",
      body: JSON.stringify(payload)
    },
    accessToken
  );
}

export function publishContest(accessToken: string, contestId: string) {
  return apiFetch<{ success: boolean }>(
    `/admin/contests/${contestId}/publish`,
    {
      method: "POST",
      body: JSON.stringify({})
    },
    accessToken
  );
}

export function recoverContest(accessToken: string, contestId: string) {
  return apiFetch<{ success: boolean }>(
    `/admin/contests/${contestId}/recover`,
    {
      method: "POST",
      body: JSON.stringify({})
    },
    accessToken
  );
}

export function getJobs(accessToken: string) {
  return apiFetch<{
    jobs: Array<{
      job_id: string;
      queue: string;
      job_name: string;
      data?: Record<string, unknown>;
      status: string;
      attempts?: number;
      scheduled_for: string;
      failed_reason: string | null;
    }>;
  }>("/admin/jobs", undefined, accessToken);
}

export function retryJob(accessToken: string, queue: string, jobId: string) {
  return apiFetch<{ success: boolean; mode: string }>(
    `/admin/jobs/${queue}/${jobId}/retry`,
    {
      method: "POST",
      body: JSON.stringify({})
    },
    accessToken
  );
}

export function rebuildContestCache(accessToken: string, contestId: string) {
  return apiFetch<{ contestId: string; status: string }>(
    `/admin/contests/${contestId}/rebuild-cache`,
    {
      method: "POST",
      body: JSON.stringify({})
    },
    accessToken
  );
}

export function getAdminUsers(accessToken: string) {
  return apiFetch<{
    users: Array<{
      id: string;
      email: string;
      name: string;
      avatar_url: string | null;
      wallet_balance: string;
      is_admin: boolean;
      is_banned: boolean;
      created_at: string;
    }>;
  }>("/admin/users", undefined, accessToken);
}

export function getWalletTopupRequests(accessToken: string) {
  return apiFetch<{
    requests: Array<{
      id: string;
      user_id: string;
      amount: string;
      status: "pending" | "approved" | "rejected";
      requested_at: string;
      reviewed_at: string | null;
      user_name: string;
      user_email: string;
    }>;
  }>("/admin/wallet-requests", undefined, accessToken);
}

export function getAdminWalletRequestsStreamUrl(accessToken: string) {
  const url = new URL(`${API_URL}/admin/wallet-requests/stream`);
  url.searchParams.set("access_token", accessToken);
  return url.toString();
}

export function approveWalletTopupRequest(accessToken: string, requestId: string) {
  return apiFetch<{ success: boolean; wallet_balance: string }>(
    `/admin/wallet-requests/${requestId}/approve`,
    {
      method: "POST",
      body: JSON.stringify({})
    },
    accessToken
  );
}

export function rejectWalletTopupRequest(accessToken: string, requestId: string) {
  return apiFetch<{ success: boolean }>(
    `/admin/wallet-requests/${requestId}/reject`,
    {
      method: "POST",
      body: JSON.stringify({})
    },
    accessToken
  );
}

export function creditUserWallet(accessToken: string, userId: string, amount: number) {
  return apiFetch<{ success: boolean; wallet_balance: string }>(
    `/admin/users/${userId}/wallet/credit`,
    {
      method: "POST",
      body: JSON.stringify({ amount })
    },
    accessToken
  );
}
