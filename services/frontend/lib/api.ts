import { API_URL, DEFAULT_ORGANIZATION_ID } from "./config";
import { clearStoredSession, updateStoredAccessToken } from "./session";
import {
  isValidOrganizationId,
  normalizeOrganizationSlugInput,
  readStoredOrganizationId,
  readStoredOrganizationSlug,
  storeOrganizationId,
  storeOrganizationIdentity,
  storeOrganizationSlug
} from "./tenant";

export type PrizeRule = "all_correct" | "top_scorer";

export interface LoginResponse {
  access_token: string;
  user: {
    id: string;
    organization_id: string;
    email: string;
    name: string;
    avatar_url?: string | null;
    wallet_balance: string;
    is_admin: boolean;
    role?: "super_admin" | "organization_admin" | "player" | "pending";
  };
}

export interface AuthMeResponse {
  user: {
    id: string;
    organization_id: string;
    email: string;
    name: string;
    avatar_url: string | null;
    is_admin: boolean;
    role: "super_admin" | "organization_admin" | "player" | "pending";
    user_status: "pending" | "active" | "blocked";
  };
  access: {
    role: "super_admin" | "organization_admin" | "player" | "pending";
    onboarding_status: "super_admin" | "approved" | "pending" | "rejected";
  };
}

export interface OrganizationSummary {
  id: string;
  name: string;
  slug: string;
  created_at: string;
}

export interface OrganizationDetails extends OrganizationSummary {
  admin_email: string;
}

export class OrganizationLookupError extends Error {
  suggestions: OrganizationSummary[];
  normalizedSlug: string | null;

  constructor(message: string, options?: { suggestions?: OrganizationSummary[]; normalizedSlug?: string | null }) {
    super(message);
    this.name = "OrganizationLookupError";
    this.suggestions = options?.suggestions ?? [];
    this.normalizedSlug = options?.normalizedSlug ?? null;
  }
}

function getConfiguredOrganizationId() {
  const storedOrganizationId = readStoredOrganizationId();
  if (storedOrganizationId) {
    return storedOrganizationId;
  }

  if (!DEFAULT_ORGANIZATION_ID || !isValidOrganizationId(DEFAULT_ORGANIZATION_ID)) {
    throw new Error("Missing valid organization context. Choose an organization ID before making tenant-scoped requests.");
  }

  return DEFAULT_ORGANIZATION_ID;
}

function getConfiguredOrganizationSlug() {
  const storedOrganizationSlug = readStoredOrganizationSlug();
  if (!storedOrganizationSlug) {
    throw new Error("Missing organization slug. Choose an organization before making tenant-scoped requests.");
  }

  return storedOrganizationSlug;
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

  if (!parsed.organization_id || !isValidOrganizationId(parsed.organization_id)) {
    throw new Error("Access token organization is missing or invalid.");
  }

  storeOrganizationId(parsed.organization_id);
  return parsed.organization_id;
}

async function apiFetch<T>(
  path: string,
  init?: RequestInit,
  accessToken?: string,
  options?: { includeTenantContext?: boolean }
): Promise<T> {
  const organizationSlug = readStoredOrganizationSlug();
  const includeTenantContext = options?.includeTenantContext ?? true;

  const buildRequest = (token?: string) => ({
    ...init,
    headers: {
      "content-type": "application/json",
      ...(includeTenantContext
        ? token
          ? {}
          : organizationSlug
            ? { "x-organization-slug": organizationSlug }
            : { "x-organization-id": getConfiguredOrganizationId() }
        : {}),
      ...(includeTenantContext && token && organizationSlug ? { "x-organization-slug": organizationSlug } : {}),
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

async function apiFetchForOrganization<T>(path: string, organizationId: string, init?: RequestInit): Promise<T> {
  if (!isValidOrganizationId(organizationId)) {
    throw new Error("A valid organization ID is required for this request.");
  }

  storeOrganizationId(organizationId);

  let response: Response;

  try {
    response = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        "x-organization-id": organizationId,
        ...(init?.headers ?? {})
      },
      credentials: "include",
      cache: "no-store"
    });
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

    throw new Error(message);
  }

  return (await response.json()) as T;
}

async function apiFetchForOrganizationSlug<T>(path: string, organizationSlug: string, init?: RequestInit): Promise<T> {
  const normalizedSlug = organizationSlug.trim().toLowerCase();
  if (!normalizedSlug) {
    throw new Error("A valid organization slug is required for this request.");
  }

  storeOrganizationSlug(normalizedSlug);

  let response: Response;

  try {
    response = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        "x-organization-slug": normalizedSlug,
        ...(init?.headers ?? {})
      },
      credentials: "include",
      cache: "no-store"
    });
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

export function getAuthMe(accessToken: string) {
  return apiFetch<AuthMeResponse>("/auth/me", undefined, accessToken, {
    includeTenantContext: false
  });
}

export function getOrganizations() {
  return Promise.resolve({ organizations: [] as OrganizationSummary[] });
}

export function lookupOrganization(input: { slug?: string; name?: string; id?: string }) {
  const url = new URL(`${API_URL}/organizations/lookup`);
  if (input.slug) {
    url.searchParams.set("slug", normalizeOrganizationSlugInput(input.slug));
  }
  if (input.name) {
    url.searchParams.set("name", input.name);
  }
  if (input.id) {
    url.searchParams.set("id", input.id);
  }

  return fetch(url.toString(), {
    credentials: "include",
    cache: "no-store"
  }).then(async (response) => {
    const body = (await response.json()) as {
      message?: string;
      organization?: OrganizationDetails;
      normalized_slug?: string;
      suggestions?: OrganizationSummary[];
    };

    if (!response.ok || !body.organization) {
      throw new OrganizationLookupError(body.message ?? `Failed to load organization (${response.status})`, {
        suggestions: body.suggestions ?? [],
        normalizedSlug: body.normalized_slug ?? null
      });
    }

    storeOrganizationIdentity({
      id: body.organization.id,
      slug: body.organization.slug,
      name: body.organization.name
    });

    return body as { organization: OrganizationDetails };
  });
}

export function createOrganization(payload: { name: string; admin_email: string; slug?: string }) {
  return fetch(`${API_URL}/organizations`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    credentials: "include",
    cache: "no-store",
    body: JSON.stringify(payload)
  }).then(async (response) => {
    const body = (await response.json()) as {
      message?: string;
      organization?: OrganizationDetails;
      onboarding?: { login_url: string };
    };

    if (!response.ok || !body.organization) {
      throw new Error(body.message ?? `Failed to create organization (${response.status})`);
    }

    storeOrganizationIdentity({
      id: body.organization.id,
      slug: body.organization.slug,
      name: body.organization.name
    });

    return body as { organization: OrganizationDetails; onboarding: { login_url: string } };
  });
}

export function requestLoginCode(payload: { email: string; name?: string; avatar_url?: string }) {
  return apiFetch<{
    success: boolean;
    email: string;
    expires_in_minutes: number;
    dev_code?: string;
  }>("/auth/request-code", {
    method: "POST",
    body: JSON.stringify({
      ...payload,
      organization_slug: getConfiguredOrganizationSlug()
    })
  });
}

export function loginWithEmailOnly(payload: { email: string; name?: string; avatar_url?: string }) {
  return apiFetch<LoginResponse>("/auth/email-login", {
    method: "POST",
    body: JSON.stringify({
      ...payload,
      organization_slug: getConfiguredOrganizationSlug()
    })
  });
}

export function verifyLoginCode(payload: { email: string; code: string }) {
  return apiFetch<LoginResponse>("/auth/verify-code", {
    method: "POST",
    body: JSON.stringify({
      ...payload,
      organization_slug: getConfiguredOrganizationSlug()
    })
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
    body: JSON.stringify({
      ...payload,
      organization_slug: getConfiguredOrganizationSlug()
    })
  });
}

export function loginWithGoogleToken(idToken: string) {
  return apiFetch<LoginResponse>("/auth/google", {
    method: "POST",
    body: JSON.stringify({
      id_token: idToken,
      organization_slug: getConfiguredOrganizationSlug()
    })
  });
}

export function joinOrganization(
  accessToken: string,
  payload: {
    organization: string;
    employee_id: string;
  }
) {
  return apiFetch<{
    success: boolean;
    membership: {
      id: string;
      status: "pending";
      organization: {
        id: string;
        slug: string;
        name: string;
      };
    };
  }>(
    "/join-organization",
    {
      method: "POST",
      body: JSON.stringify(payload)
    },
    accessToken,
    { includeTenantContext: false }
  );
}

export function getPendingUsers(accessToken: string) {
  return apiFetch<{
    pending_users: Array<{
      membership_id: string;
      user_id: string;
      email: string;
      name: string;
      organization_id: string;
      organization_name: string;
      organization_slug: string;
      employee_id: string;
      created_at: string;
    }>;
  }>("/admin/pending-users", undefined, accessToken);
}

export function approveUser(
  accessToken: string,
  payload: {
    membership_id: string;
    role: "organization_admin" | "player";
    action: "approve" | "reject";
  }
) {
  return apiFetch<{ success: boolean; action: "approved" | "rejected" }>(
    "/admin/approve-user",
    {
      method: "POST",
      body: JSON.stringify(payload)
    },
    accessToken
  );
}

export function createSaaSOrganization(
  _accessToken: string,
  payload: {
    name: string;
    slug: string;
    admin_email: string;
  }
) {
  return fetch(`${API_URL}/organizations`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    credentials: "include",
    cache: "no-store",
    body: JSON.stringify(payload)
  }).then(async (response) => {
    const body = (await response.json()) as {
      message?: string;
      organization?: {
        id: string;
        name: string;
        slug: string;
        admin_email: string;
        created_at: string;
      };
    };

    if (!response.ok || !body.organization) {
      throw new Error(body.message ?? `Failed to create organization (${response.status})`);
    }

    return {
      organization: {
        id: body.organization.id,
        name: body.organization.name,
        slug: body.organization.slug,
        is_active: true
      }
    };
  });
}

export function getSystemUsers(accessToken: string) {
  return apiFetch<{
    users: Array<{
      id: string;
      email: string;
      name: string;
      status: string;
      organization_id: string;
      created_at: string;
    }>;
  }>("/admin/system/users", undefined, accessToken, {
    includeTenantContext: false
  });
}

export function getSystemActivity(accessToken: string) {
  return apiFetch<{
    activity: Array<{
      id: string;
      action: string;
      target_type: string;
      target_id: string | null;
      created_at: string;
      metadata: Record<string, unknown>;
    }>;
  }>("/admin/system/activity", undefined, accessToken, {
    includeTenantContext: false
  });
}

export function getOrganizationsForSuperAdmin(accessToken: string) {
  return apiFetch<{
    organizations: Array<{
      id: string;
      name: string;
      slug: string;
      admin_email: string;
      is_active: boolean;
      created_at: string;
    }>;
  }>("/admin/organizations", undefined, accessToken, {
    includeTenantContext: false
  });
}

export function updateOrganizationForSuperAdmin(
  accessToken: string,
  organizationId: string,
  payload: {
    name: string;
    slug: string;
    admin_email: string;
  }
) {
  return apiFetch<{
    organization: {
      id: string;
      name: string;
      slug: string;
      admin_email: string;
      is_active: boolean;
    };
  }>(
    `/admin/update-organization/${organizationId}`,
    {
      method: "POST",
      body: JSON.stringify(payload)
    },
    accessToken,
    { includeTenantContext: false }
  );
}

export function toggleOrganizationForSuperAdmin(
  accessToken: string,
  organizationId: string,
  isActive: boolean
) {
  return apiFetch<{
    organization: {
      id: string;
      is_active: boolean;
    };
  }>(
    "/admin/toggle-organization",
    {
      method: "POST",
      body: JSON.stringify({
        organization_id: organizationId,
        is_active: isActive
      })
    },
    accessToken,
    { includeTenantContext: false }
  );
}

export function deleteOrganizationForSuperAdmin(accessToken: string, organizationId: string) {
  return apiFetch<{ success: boolean }>(
    `/admin/organizations/${organizationId}`,
    {
      method: "DELETE"
    },
    accessToken,
    { includeTenantContext: false }
  );
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

export function getLeaderboard(contestId: string, organizationId?: string) {
  const request = `/contests/${contestId}/leaderboard`;
  const organizationSlug = readStoredOrganizationSlug();

  if (organizationId) {
    return apiFetchForOrganization<{
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
    }>(request, organizationId);
  }

  if (organizationSlug) {
    return apiFetchForOrganizationSlug<{
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
    }>(request, organizationSlug);
  }

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
  }>(request);
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
  const organizationSlug = readStoredOrganizationSlug();
  if (organizationSlug) {
    url.searchParams.set("organization", organizationSlug);
  }
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
