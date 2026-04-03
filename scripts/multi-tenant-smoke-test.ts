const API_BASE_URL = process.env.API_BASE_URL ?? "http://localhost:4000";
const ORG_A_ID =
  process.env.TEST_ORG_A_ID ??
  process.env.DEFAULT_ORGANIZATION_ID ??
  "6d0f6f11-4d7d-4d6c-9b9e-0f5f89c4f3a1";
const ORG_B_ID = process.env.TEST_ORG_B_ID ?? "22222222-2222-4222-8222-222222222222";
const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL ?? process.env.ADMIN_EMAIL ?? "tenant-admin@example.com";
const RUN_ID = Date.now().toString(36);

type UserSession = {
  access_token: string;
  user: {
    id: string;
    organization_id: string;
    email: string;
  };
};

type ContestListResponse = {
  contests: Array<{
    id: string;
    starts_at: string;
  }>;
};

type WalletRequestsResponse = {
  requests: Array<{
    id: string;
  }>;
};

type CreateContestResponse = {
  contest: {
    id: string;
  };
};

type CreateWalletRequestResponse = {
  request: {
    id: string;
  };
};

function jsonHeaders(organizationId: string, accessToken?: string) {
  return {
    "content-type": "application/json",
    "x-organization-id": organizationId,
    ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {})
  };
}

async function apiRequest<T>(path: string, options: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, options);
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`${options.method ?? "GET"} ${path} failed with ${response.status}: ${text}`);
  }

  return (text ? JSON.parse(text) : {}) as T;
}

async function loginUser(email: string, name: string, organizationId: string) {
  return apiRequest<UserSession>("/auth/email-login", {
    method: "POST",
    headers: jsonHeaders(organizationId),
    body: JSON.stringify({ email, name })
  });
}

async function createContestForTenant(accessToken: string, organizationId: string, title: string) {
  return apiRequest<CreateContestResponse>("/admin/contests", {
    method: "POST",
    headers: jsonHeaders(organizationId, accessToken),
    body: JSON.stringify({
      title,
      starts_at: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
      entry_fee: 10,
      max_members: 10,
      prize_rule: "top_scorer"
    })
  });
}

async function getPublicContestList(organizationId: string) {
  return apiRequest<ContestListResponse>("/contests/all", {
    method: "GET",
    headers: {
      "x-organization-id": organizationId
    }
  });
}

async function getAdminContestList(accessToken: string, organizationId: string) {
  return apiRequest<ContestListResponse>("/admin/contests", {
    method: "GET",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "x-organization-id": organizationId
    }
  });
}

async function createWalletRequestForTenant(accessToken: string, organizationId: string, amount: number) {
  return apiRequest<CreateWalletRequestResponse>("/wallet/request-money", {
    method: "POST",
    headers: jsonHeaders(organizationId, accessToken),
    body: JSON.stringify({ amount })
  });
}

async function getWalletRequests(accessToken: string, organizationId: string) {
  return apiRequest<WalletRequestsResponse>("/wallet/requests", {
    method: "GET",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "x-organization-id": organizationId
    }
  });
}

async function getAuthMeStatus(accessToken: string, organizationId: string) {
  const response = await fetch(`${API_BASE_URL}/auth/me`, {
    method: "GET",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "x-organization-id": organizationId
    }
  });

  return response.status;
}

function expectTrue(value: boolean, message: string) {
  if (!value) {
    throw new Error(message);
  }
}

function listContainsId(items: Array<{ id: string }>, id: string) {
  return items.some((item) => item.id === id);
}

async function testContestIsolation(adminA: UserSession, adminB: UserSession) {
  // Create a contest in tenant A and make sure tenant B cannot see it.
  const createdContest = await createContestForTenant(
    adminA.access_token,
    ORG_A_ID,
    `Tenant Smoke Contest ${RUN_ID}`
  );
  const contestId = createdContest.contest.id;

  const publicContestsA = await getPublicContestList(ORG_A_ID);
  const publicContestsB = await getPublicContestList(ORG_B_ID);
  const adminContestsA = await getAdminContestList(adminA.access_token, ORG_A_ID);
  const adminContestsB = await getAdminContestList(adminB.access_token, ORG_B_ID);

  expectTrue(
    listContainsId(publicContestsA.contests, contestId),
    "Tenant A cannot see its own contest in the public contest list"
  );
  expectTrue(
    !listContainsId(publicContestsB.contests, contestId),
    "Tenant B can see tenant A contest in the public contest list"
  );
  expectTrue(
    listContainsId(adminContestsA.contests, contestId),
    "Tenant A admin cannot see its own contest"
  );
  expectTrue(
    !listContainsId(adminContestsB.contests, contestId),
    "Tenant B admin can see tenant A contest"
  );

  return contestId;
}

async function testWalletIsolation() {
  // Create one wallet request in tenant A and make sure tenant B cannot see it.
  const walletUserA = await loginUser(`tenant-wallet-a-${RUN_ID}@example.com`, "Wallet User A", ORG_A_ID);
  const walletUserB = await loginUser(`tenant-wallet-b-${RUN_ID}@example.com`, "Wallet User B", ORG_B_ID);

  const createdRequest = await createWalletRequestForTenant(walletUserA.access_token, ORG_A_ID, 25);
  const walletRequestId = createdRequest.request.id;

  const requestsA = await getWalletRequests(walletUserA.access_token, ORG_A_ID);
  const requestsB = await getWalletRequests(walletUserB.access_token, ORG_B_ID);

  expectTrue(
    listContainsId(requestsA.requests, walletRequestId),
    "Tenant A cannot see its own wallet request"
  );
  expectTrue(
    !listContainsId(requestsB.requests, walletRequestId),
    "Tenant B can see tenant A wallet request"
  );

  return walletRequestId;
}

async function testTokenHeaderMismatch(accessToken: string) {
  // A token from tenant A should not work with tenant B's organization header.
  const status = await getAuthMeStatus(accessToken, ORG_B_ID);
  expectTrue(status === 401, `Expected token/header mismatch to return 401, got ${status}`);
  return status;
}

async function main() {
  console.log(`Using API ${API_BASE_URL}`);
  console.log(`Testing tenants ${ORG_A_ID} and ${ORG_B_ID}`);

  const adminA = await loginUser(ADMIN_EMAIL, "Tenant Admin", ORG_A_ID);
  const adminB = await loginUser(ADMIN_EMAIL, "Tenant Admin", ORG_B_ID);

  expectTrue(adminA.user.organization_id === ORG_A_ID, "Tenant A login returned the wrong organization");
  expectTrue(adminB.user.organization_id === ORG_B_ID, "Tenant B login returned the wrong organization");

  const contestId = await testContestIsolation(adminA, adminB);
  const walletRequestId = await testWalletIsolation();
  const mismatchStatus = await testTokenHeaderMismatch(adminA.access_token);

  console.log("");
  console.log("Multi-tenant smoke test passed.");
  console.log(`Contest isolation OK: ${contestId}`);
  console.log(`Wallet isolation OK: ${walletRequestId}`);
  console.log(`Token/header mismatch rejected with ${mismatchStatus}`);
}

main().catch((error) => {
  console.error("Multi-tenant smoke test failed.");
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
