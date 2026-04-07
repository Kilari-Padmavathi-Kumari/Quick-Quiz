import { randomBytes } from "node:crypto";

import { withTransaction } from "@quiz-app/db";
import type { FastifyInstance } from "fastify";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";

import { config } from "../env.js";
import {
  authenticate,
  authenticateAccessToken,
  clearRefreshCookie,
  createSession,
  getRefreshCookieName,
  PLATFORM_GLOBAL_ORG_ID,
  rotateSession,
  revokeRefreshToken,
  setRefreshCookie
} from "../lib/auth.js";
import { redis } from "../lib/redis.js";
import { writeAuditLog } from "../lib/audit.js";
import { enforceRateLimit } from "../lib/rate-limit.js";
import { lookupOrganizationIdBySlug, requireResolvedOrganizationId } from "../lib/tenant.js";

const googleSchema = z.object({
  id_token: z.string().min(10)
});

const devEmailLoginSchema = z.object({
  email: z.string().email(),
  name: z.string().trim().min(1).max(120).optional(),
  avatar_url: z.string().url().optional()
});

const authStateKey = (state: string) => `auth:google:state:${state}`;

type GoogleOauthStatePayload = {
  redirect_to: string;
  organization_id?: string;
};

function buildFallbackAvatarUrl(name: string, email: string) {
  const seed = name.trim() || email.trim() || "Quiz Player";
  const url = new URL("https://ui-avatars.com/api/");
  url.searchParams.set("name", seed);
  url.searchParams.set("background", "0F4C81");
  url.searchParams.set("color", "FFFFFF");
  url.searchParams.set("bold", "true");
  url.searchParams.set("format", "png");
  url.searchParams.set("size", "256");
  return url.toString();
}

function resolveAvatarUrl({
  avatarUrl,
  existingAvatarUrl,
  name,
  email
}: {
  avatarUrl?: string | null;
  existingAvatarUrl?: string | null;
  name: string;
  email: string;
}) {
  const trimmedAvatarUrl = avatarUrl?.trim();

  if (trimmedAvatarUrl) {
    return trimmedAvatarUrl;
  }

  if (existingAvatarUrl?.trim()) {
    return existingAvatarUrl.trim();
  }

  return buildFallbackAvatarUrl(name, email);
}

async function loadOrCreateGlobalUserFromIdentity({
  provider,
  providerUid,
  email,
  name,
  avatarUrl
}: {
  provider: string;
  providerUid: string;
  email: string;
  name: string;
  avatarUrl?: string | null;
}) {
  return withTransaction(async (client) => {
    const existingUser = await client.query<{
      id: string;
      organization_id: string;
      email: string;
      name: string;
      avatar_url: string | null;
      wallet_balance: string;
      is_admin: boolean;
      is_banned: boolean;
      status: "pending" | "active" | "blocked";
    }>(
      `
        SELECT id, organization_id, email, name, avatar_url, wallet_balance, is_admin, is_banned, status
        FROM users
        WHERE LOWER(email) = LOWER($1)
        ORDER BY created_at ASC
        LIMIT 1
      `,
      [email]
    );

    const user =
      existingUser.rowCount === 1
        ? (
            await client.query<{
              id: string;
              organization_id: string;
              email: string;
              name: string;
              avatar_url: string | null;
              wallet_balance: string;
              is_admin: boolean;
              is_banned: boolean;
              status: "pending" | "active" | "blocked";
            }>(
              `
                UPDATE users
                SET name = $2,
                    avatar_url = $3,
                    updated_at = NOW()
                WHERE id = $1
                RETURNING id, organization_id, email, name, avatar_url, wallet_balance, is_admin, is_banned, status
              `,
              [
                existingUser.rows[0].id,
                name,
                resolveAvatarUrl({
                  avatarUrl,
                  existingAvatarUrl: existingUser.rows[0].avatar_url,
                  name,
                  email
                })
              ]
            )
          ).rows[0]
        : (
            await client.query<{
              id: string;
              organization_id: string;
              email: string;
              name: string;
              avatar_url: string | null;
              wallet_balance: string;
              is_admin: boolean;
              is_banned: boolean;
              status: "pending" | "active" | "blocked";
            }>(
              `
                INSERT INTO users (organization_id, email, name, avatar_url, is_admin, wallet_balance, status)
                VALUES ($1, $2, $3, $4, FALSE, '100.00', 'pending')
                RETURNING id, organization_id, email, name, avatar_url, wallet_balance, is_admin, is_banned, status
              `,
              [
                PLATFORM_GLOBAL_ORG_ID,
                email,
                name,
                resolveAvatarUrl({
                  avatarUrl,
                  name,
                  email
                })
              ]
            )
          ).rows[0];

    await client.query(
      `
        INSERT INTO oauth_accounts (user_id, provider, provider_uid, email, organization_id)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (organization_id, provider, provider_uid) DO NOTHING
      `,
      [user.id, provider, providerUid, email, user.organization_id]
    );

    return user;
  });
}

async function resolveLoginAccess(user: {
  id: string;
  organization_id: string;
  email: string;
  is_banned: boolean;
  status: "pending" | "active" | "blocked";
}) {
  const superAdminResult = await withTransaction(async (client) => {
    const result = await client.query<{ email: string }>(
      `
        SELECT email
        FROM super_admins
        WHERE email = $1
          AND is_active = TRUE
        LIMIT 1
      `,
      [user.email]
    );

    return result.rowCount === 1;
  });

  if (superAdminResult) {
    return {
      organizationId: PLATFORM_GLOBAL_ORG_ID,
      role: "super_admin" as const,
      userStatus: user.status === "blocked" ? "blocked" as const : "active" as const
    };
  }

  const membershipResult = await withTransaction(async (client) =>
    client.query<{
      organization_id: string;
      role: "organization_admin" | "player";
      status: "pending" | "approved" | "rejected";
    }>(
      `
        SELECT organization_id, role, status
        FROM memberships
        WHERE user_id = $1
        ORDER BY
          CASE WHEN status = 'approved' THEN 0 WHEN status = 'pending' THEN 1 ELSE 2 END,
          created_at ASC
        LIMIT 1
      `,
      [user.id]
    )
  );

  if (membershipResult.rowCount !== 1) {
    return {
      organizationId: PLATFORM_GLOBAL_ORG_ID,
      role: "pending" as const,
      userStatus: "pending" as const
    };
  }

  const membership = membershipResult.rows[0];

  if (membership.status !== "approved") {
    return {
      organizationId: PLATFORM_GLOBAL_ORG_ID,
      role: "pending" as const,
      userStatus: membership.status === "rejected" ? "blocked" as const : "pending" as const
    };
  }

  return {
    organizationId: membership.organization_id,
    role: membership.role,
    userStatus: user.status === "blocked" ? "blocked" as const : "active" as const
  };
}

async function syncUserAccessState(params: {
  userId: string;
  organizationId: string;
  role: "super_admin" | "organization_admin" | "player" | "pending";
  userStatus: "pending" | "active" | "blocked";
}) {
  const normalizedStatus =
    params.userStatus === "blocked"
      ? "blocked"
      : params.role === "pending"
        ? "pending"
        : "active";

  await withTransaction(async (client) => {
    await client.query(
      `
        UPDATE users
        SET organization_id = $2,
            status = $3,
            is_admin = $4,
            updated_at = NOW()
        WHERE id = $1
      `,
      [
        params.userId,
        params.organizationId,
        normalizedStatus,
        params.role === "organization_admin"
      ]
    );
  });
}

async function loadOrCreateUserForOrganization(params: {
  email: string;
  name: string;
  organizationId: string;
  avatarUrl?: string | null;
}) {
  return withTransaction(async (client) => {
    const existingUser = await client.query<{
      id: string;
      organization_id: string;
      email: string;
      name: string;
      avatar_url: string | null;
      wallet_balance: string;
      is_admin: boolean;
      is_banned: boolean;
      status: "pending" | "active" | "blocked";
    }>(
      `
        SELECT id, organization_id, email, name, avatar_url, wallet_balance, is_admin, is_banned, status
        FROM users
        WHERE LOWER(email) = LOWER($1)
        ORDER BY created_at ASC
        LIMIT 1
      `,
      [params.email]
    );

    const user =
      existingUser.rowCount === 1
        ? (
            await client.query<{
              id: string;
              organization_id: string;
              email: string;
              name: string;
              avatar_url: string | null;
              wallet_balance: string;
              is_admin: boolean;
              is_banned: boolean;
              status: "pending" | "active" | "blocked";
            }>(
              `
                UPDATE users
                SET name = $2,
                    avatar_url = $3,
                    updated_at = NOW()
                WHERE id = $1
                RETURNING id, organization_id, email, name, avatar_url, wallet_balance, is_admin, is_banned, status
              `,
              [
                existingUser.rows[0].id,
                params.name,
                resolveAvatarUrl({
                  avatarUrl: params.avatarUrl,
                  existingAvatarUrl: existingUser.rows[0].avatar_url,
                  name: params.name,
                  email: params.email
                })
              ]
            )
          ).rows[0]
        : (
            await client.query<{
              id: string;
              organization_id: string;
              email: string;
              name: string;
              avatar_url: string | null;
              wallet_balance: string;
              is_admin: boolean;
              is_banned: boolean;
              status: "pending" | "active" | "blocked";
            }>(
              `
                INSERT INTO users (organization_id, email, name, avatar_url, is_admin, wallet_balance, status)
                VALUES ($1, $2, $3, $4, FALSE, '100.00', 'active')
                RETURNING id, organization_id, email, name, avatar_url, wallet_balance, is_admin, is_banned, status
              `,
              [
                params.organizationId,
                params.email,
                params.name,
                resolveAvatarUrl({
                  avatarUrl: params.avatarUrl,
                  name: params.name,
                  email: params.email
                })
              ]
            )
          ).rows[0];

    const membershipResult = await client.query<{
      role: "organization_admin" | "player";
      status: "pending" | "approved" | "rejected";
    }>(
      `
        INSERT INTO memberships (user_id, organization_id, role, employee_id, status, approved_at, updated_at)
        VALUES ($1, $2, 'player', $3, 'approved', NOW(), NOW())
        ON CONFLICT (user_id, organization_id) DO UPDATE
        SET updated_at = NOW()
        RETURNING role, status
      `,
      [user.id, params.organizationId, `dev-${user.id.slice(0, 8)}`]
    );

    return {
      user,
      membership: membershipResult.rows[0]
    };
  });
}

type SessionResult =
  | {
      status: 200;
      session: {
        accessToken: string;
        refreshToken: string;
      };
    }
  | {
      status: 403;
      body: { message: string };
    };

async function issueSessionForUser(user: {
  id: string;
  organization_id: string;
  email: string;
  is_admin: boolean;
  is_banned: boolean;
  role?: "super_admin" | "organization_admin" | "player" | "pending";
  user_status?: "pending" | "active" | "blocked";
}): Promise<SessionResult> {
  const role = user.role ?? (user.is_admin ? "organization_admin" : "player");
  const userStatus = user.user_status ?? (user.is_banned ? "blocked" : "active");

  if (user.is_banned || userStatus === "blocked") {
    return { status: 403, body: { message: "User account is banned" } };
  }

  const session = await createSession({
    id: user.id,
    organization_id: user.organization_id,
    email: user.email,
    is_admin: user.is_admin,
    is_banned: user.is_banned,
    role,
    user_status: userStatus
  });

  return { status: 200, session };
}

async function verifyGoogleIdToken(idToken: string) {
  const clientId = config.googleClientId;
  const jwksUrl = process.env.GOOGLE_JWKS_URL ?? "https://www.googleapis.com/oauth2/v3/certs";

  if (!clientId) {
    throw new Error("Google OAuth is not configured");
  }

  const jwks = createRemoteJWKSet(new URL(jwksUrl));
  const { payload } = await jwtVerify(idToken, jwks, {
    issuer: ["https://accounts.google.com", "accounts.google.com"],
    audience: clientId
  });

  const email = String(payload.email ?? "").toLowerCase();
  const sub = String(payload.sub ?? "");
  const emailVerified = payload.email_verified === true;

  if (!email || !sub || !emailVerified) {
    throw new Error("Invalid Google token payload");
  }

  return {
    providerUid: sub,
    email,
    name: String(payload.name ?? email.split("@")[0]),
    avatarUrl: payload.picture ? String(payload.picture) : null
  };
}

function resolveFrontendRedirect(target?: string) {
  if (!target) {
    return `${config.frontendUrl}/dashboard`;
  }

  if (target.startsWith("/")) {
    return `${config.frontendUrl}${target}`;
  }

  try {
    const targetUrl = new URL(target);
    const frontendUrl = new URL(config.frontendUrl);

    if (targetUrl.origin !== frontendUrl.origin) {
      return `${config.frontendUrl}/dashboard`;
    }

    return targetUrl.toString();
  } catch {
    return `${config.frontendUrl}/dashboard`;
  }
}

function buildFrontendAuthCallbackUrl(redirectTo: string) {
  const callbackUrl = new URL("/auth/callback", config.frontendUrl);
  callbackUrl.searchParams.set("next", redirectTo);
  return callbackUrl.toString();
}

function buildFrontendErrorUrl(message: string) {
  const errorUrl = new URL("/", config.frontendUrl);
  errorUrl.searchParams.set("error", message);
  return errorUrl.toString();
}

async function exchangeGoogleAuthorizationCode(code: string) {
  if (!config.googleClientId || !config.googleClientSecret) {
    throw new Error("Google OAuth client credentials are not configured");
  }

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      code,
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      redirect_uri: config.googleRedirectUri,
      grant_type: "authorization_code"
    })
  });

  if (!tokenResponse.ok) {
    const body = await tokenResponse.text();
    throw new Error(`Google token exchange failed: ${body}`);
  }

  const tokenBody = (await tokenResponse.json()) as {
    id_token?: string;
  };

  if (!tokenBody.id_token) {
    throw new Error("Google token response did not include an id_token");
  }

  return verifyGoogleIdToken(tokenBody.id_token);
}

export async function authRoutes(app: FastifyInstance) {
  app.post("/auth/email-login", async (request, reply) => {
    if (process.env.NODE_ENV === "production") {
      return reply.code(404).send({ message: "Route not found" });
    }

    await enforceRateLimit(request, {
      scope: "auth-email-login",
      limit: 30,
      windowSec: 60
    });

    const body = devEmailLoginSchema.parse(request.body);
    const organizationId = await requireResolvedOrganizationId(request);
    const normalizedEmail = body.email.trim().toLowerCase();
    const displayName = body.name?.trim() || normalizedEmail.split("@")[0];

    const { user, membership } = await loadOrCreateUserForOrganization({
      email: normalizedEmail,
      name: displayName,
      organizationId,
      avatarUrl: body.avatar_url ?? null
    });

    const role =
      membership.status === "approved"
        ? membership.role
        : "pending";

    const userStatus =
      membership.status === "rejected"
        ? "blocked" as const
        : membership.status === "approved"
          ? "active" as const
          : "pending" as const;

    await syncUserAccessState({
      userId: user.id,
      organizationId,
      role,
      userStatus
    });

    const session = await createSession({
      id: user.id,
      organization_id: organizationId,
      email: user.email,
      is_admin: role === "organization_admin",
      is_banned: user.is_banned,
      role,
      user_status: userStatus
    });

    setRefreshCookie(reply, session.refreshToken);

    return {
      access_token: session.accessToken,
      user: {
        id: user.id,
        organization_id: organizationId,
        email: user.email,
        name: user.name,
        avatar_url: user.avatar_url,
        wallet_balance: user.wallet_balance,
        is_admin: role === "organization_admin",
        role
      }
    };
  });

  app.get("/auth/google", async (request, reply) => {
    await enforceRateLimit(request, {
      scope: "auth-google-start",
      limit: 20,
      windowSec: 60
    });

    if (!config.googleClientId || !config.googleClientSecret) {
      return reply.redirect(buildFrontendErrorUrl("Google OAuth is not configured on the server."));
    }

    const state = randomBytes(24).toString("hex");
    const query = request.query as { redirect_to?: string; organization?: string; organization_slug?: string };
    const redirectTo = resolveFrontendRedirect(String(query.redirect_to ?? ""));
    const organizationSlug = String(query.organization_slug ?? query.organization ?? "").trim().toLowerCase();

    let organizationId: string | undefined;

    if (organizationSlug) {
      try {
        organizationId = await lookupOrganizationIdBySlug(organizationSlug);
      } catch (error) {
        return reply.redirect(buildFrontendErrorUrl(error instanceof Error ? error.message : "Organization not found."));
      }
    }

    await redis.setex(
      authStateKey(state),
      config.authCodeTtlMinutes * 60,
      JSON.stringify({
        redirect_to: redirectTo,
        organization_id: organizationId
      } satisfies GoogleOauthStatePayload)
    );

    const googleUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    googleUrl.searchParams.set("client_id", config.googleClientId);
    googleUrl.searchParams.set("redirect_uri", config.googleRedirectUri);
    googleUrl.searchParams.set("response_type", "code");
    googleUrl.searchParams.set("scope", "openid email profile");
    googleUrl.searchParams.set("state", state);
    googleUrl.searchParams.set("access_type", "offline");
    googleUrl.searchParams.set("prompt", "consent");

    return reply.redirect(googleUrl.toString());
  });

  app.get("/auth/google/callback", async (request, reply) => {
    await enforceRateLimit(request, {
      scope: "auth-google-callback",
      limit: 20,
      windowSec: 60
    });

    const { code, state, error } = request.query as {
      code?: string;
      state?: string;
      error?: string;
    };

    if (error) {
      await writeAuditLog({
        action: "auth.google.failed",
        targetType: "auth",
        metadata: { reason: error }
      });
      return reply.redirect(buildFrontendErrorUrl(`Google login failed: ${error}`));
    }

    if (!code || !state) {
      await writeAuditLog({
        action: "auth.google.failed",
        targetType: "auth",
        metadata: { reason: "missing_code_or_state" }
      });
      return reply.redirect(buildFrontendErrorUrl("Missing Google OAuth code or state."));
    }

    const rawState = await redis.get(authStateKey(state));
    if (!rawState) {
      await writeAuditLog({
        action: "auth.google.failed",
        targetType: "auth",
        metadata: { reason: "invalid_or_expired_state" }
      });
      return reply.redirect(buildFrontendErrorUrl("Google OAuth state is invalid or expired."));
    }

    await redis.del(authStateKey(state));
    const parsedState = JSON.parse(rawState) as GoogleOauthStatePayload;

    try {
      const profile = await exchangeGoogleAuthorizationCode(code);

      const user = await loadOrCreateGlobalUserFromIdentity({
        provider: "google",
        providerUid: profile.providerUid,
        email: profile.email,
        name: profile.name,
        avatarUrl: profile.avatarUrl
      });

      const access = await resolveLoginAccess(user);

      await syncUserAccessState({
        userId: user.id,
        organizationId: access.organizationId,
        role: access.role,
        userStatus: access.userStatus
      });

      const finalSession = await createSession({
        id: user.id,
        organization_id: access.organizationId,
        email: user.email,
        is_admin: access.role === "organization_admin",
        is_banned: user.is_banned,
        role: access.role,
        user_status: access.userStatus
      });

      setRefreshCookie(reply, finalSession.refreshToken);
      await writeAuditLog({
        actorUserId: user.id,
        organizationId: access.organizationId,
        action: "auth.google.succeeded",
        targetType: "auth",
        metadata: {
          role: access.role,
          user_status: access.userStatus
        }
      });
      return reply.redirect(buildFrontendAuthCallbackUrl(parsedState.redirect_to));
    } catch (oauthError) {
      await writeAuditLog({
        action: "auth.google.failed",
        targetType: "auth",
        metadata: {
          reason: oauthError instanceof Error ? oauthError.message : "google_oauth_failed"
        }
      });
      return reply.redirect(buildFrontendErrorUrl(oauthError instanceof Error ? oauthError.message : "Google OAuth failed"));
    }
  });

  app.post("/auth/refresh", async (request, reply) => {
    await enforceRateLimit(request, {
      scope: "auth-refresh",
      limit: 30,
      windowSec: 60
    });

    const rawRefreshToken = request.cookies[getRefreshCookieName()];

    if (!rawRefreshToken) {
      return reply.code(401).send({ message: "Missing refresh token cookie" });
    }

    const nextSession = await rotateSession(rawRefreshToken);

    if (!nextSession) {
      clearRefreshCookie(reply);
      return reply.code(401).send({ message: "Refresh token is invalid or expired" });
    }

    const verifiedSession = await authenticateAccessToken(nextSession.accessToken);
    if (!verifiedSession.user) {
      clearRefreshCookie(reply);
      return reply.code(401).send({ message: verifiedSession.error });
    }

    setRefreshCookie(reply, nextSession.refreshToken);

    return {
      access_token: nextSession.accessToken
    };
  });

  app.post("/auth/logout", async (request, reply) => {
    const rawRefreshToken = request.cookies[getRefreshCookieName()];

    if (rawRefreshToken) {
      await revokeRefreshToken(rawRefreshToken);
    }

    clearRefreshCookie(reply);
    return { success: true };
  });

  app.get("/auth/me", { preHandler: authenticate }, async (request) => ({
    user: request.user,
    access: {
      role: request.user.role,
      onboarding_status:
        request.user.role === "super_admin"
          ? "super_admin"
          : request.user.role === "pending"
            ? request.user.user_status === "blocked"
              ? "rejected"
              : "pending"
            : "approved"
    }
  }));
}
