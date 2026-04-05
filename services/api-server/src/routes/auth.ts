import { createHash, randomBytes, randomInt } from "node:crypto";

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
  rotateSession,
  revokeRefreshToken,
  setRefreshCookie
} from "../lib/auth.js";
import { redis } from "../lib/redis.js";
import { enforceRateLimit } from "../lib/rate-limit.js";
import {
  lookupOrganizationIdBySlug,
  requireResolvedOrganizationId
} from "../lib/tenant.js";

const requestCodeSchema = z.object({
  organization_slug: z.string().trim().min(2).max(48).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional(),
  email: z.string().email(),
  name: z.string().min(2).max(80).optional(),
  avatar_url: z.string().url().optional()
});

const verifyCodeSchema = z.object({
  organization_slug: z.string().trim().min(2).max(48).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional(),
  email: z.string().email(),
  code: z.string().min(4).max(12)
});

const googleSchema = z.object({
  id_token: z.string().min(10)
});

const passwordSchema = z.object({
  organization_slug: z.string().trim().min(2).max(48).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional(),
  email: z.string().email(),
  password: z.string().min(6),
  name: z.string().min(2).max(80).optional(),
  avatar_url: z.string().url().optional()
});

const emailLoginSchema = z.object({
  organization_slug: z.string().trim().min(2).max(48).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional(),
  email: z.string().email(),
  name: z.string().min(2).max(80).optional(),
  avatar_url: z.string().url().optional()
});

const authCodeKey = (organizationId: string, email: string) => `auth:code:${organizationId}:${email}`;
const authStateKey = (state: string) => `auth:google:state:${state}`;

type AuthCodePayload = {
  code: string;
  name?: string;
  avatar_url?: string;
};

type GoogleOauthStatePayload = {
  redirect_to: string;
  organization_id: string;
};

function makeDevProviderUid(email: string) {
  return `dev_${createHash("sha256").update(email).digest("hex")}`;
}

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

async function resolveUserFromOauth({
  organizationId,
  provider,
  providerUid,
  email,
  name,
  avatarUrl
}: {
  organizationId: string;
  provider: string;
  providerUid: string;
  email: string;
  name: string;
  avatarUrl?: string | null;
}) {
  return withTransaction(async (client) => {
    const loadUserByOrganizationEmail = async () =>
      client.query<{
        id: string;
        organization_id: string;
        email: string;
        name: string;
        avatar_url: string | null;
        wallet_balance: string;
        is_admin: boolean;
        is_banned: boolean;
      }>(
        `
          SELECT id, organization_id, email, name, avatar_url, wallet_balance, is_admin, is_banned
          FROM users
          WHERE organization_id = $1
            AND email = $2
          LIMIT 1
        `,
        [organizationId, email]
      );

    const organizationResult = await client.query<{
      admin_email: string;
    }>(
      `
        SELECT admin_email
        FROM organizations
        WHERE id = $1
        LIMIT 1
      `,
      [organizationId]
    );

    const organizationAdminEmail = organizationResult.rows[0]?.admin_email?.toLowerCase();
    const shouldGrantAdmin =
      email === organizationAdminEmail ||
      (organizationId === config.defaultOrganizationId && email === config.adminEmail);

    const oauthResult = await client.query<{
      id: string;
      organization_id: string;
      email: string;
      name: string;
      avatar_url: string | null;
      wallet_balance: string;
      is_admin: boolean;
      is_banned: boolean;
    }>(
      `
        SELECT
          u.id,
          u.organization_id,
          u.email,
          u.name,
          u.avatar_url,
          u.wallet_balance,
          u.is_admin,
          u.is_banned
        FROM oauth_accounts oa
        JOIN users u ON u.id = oa.user_id
        WHERE oa.organization_id = $1
          AND oa.provider = $2
          AND oa.provider_uid = $3
        LIMIT 1
      `,
      [organizationId, provider, providerUid]
    );

    if (oauthResult.rowCount === 1) {
      const existingOauthUser = oauthResult.rows[0];
      const resolvedAvatarUrl = resolveAvatarUrl({
        avatarUrl,
        existingAvatarUrl: existingOauthUser.avatar_url,
        name,
        email
      });

      return (
        await client.query<{
          id: string;
          organization_id: string;
          email: string;
          name: string;
          avatar_url: string | null;
          wallet_balance: string;
          is_admin: boolean;
          is_banned: boolean;
        }>(
          `
            UPDATE users
            SET name = $2,
                avatar_url = $3,
                is_admin = $4,
                updated_at = NOW()
            WHERE id = $1
              AND organization_id = $5
            RETURNING id, organization_id, email, name, avatar_url, wallet_balance, is_admin, is_banned
          `,
          [existingOauthUser.id, name, resolvedAvatarUrl, existingOauthUser.is_admin || shouldGrantAdmin, organizationId]
        )
      ).rows[0];
    }

    const existingUser = await loadUserByOrganizationEmail();

    const user =
      existingUser.rows[0]
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
            }>(
              `
                UPDATE users
                SET name = $2,
                    avatar_url = $3,
                    is_admin = $4,
                    updated_at = NOW()
                WHERE id = $1
                  AND organization_id = $5
                RETURNING id, organization_id, email, name, avatar_url, wallet_balance, is_admin, is_banned
              `,
              [
                existingUser.rows[0].id,
                name,
                resolveAvatarUrl({
                  avatarUrl,
                  existingAvatarUrl: existingUser.rows[0].avatar_url,
                  name,
                  email
                }),
                existingUser.rows[0].is_admin || shouldGrantAdmin,
                organizationId
              ]
            )
          ).rows[0]
        : await (async () => {
            try {
              return (
                await client.query<{
                  id: string;
                  organization_id: string;
                  email: string;
                  name: string;
                  avatar_url: string | null;
                  wallet_balance: string;
                  is_admin: boolean;
                  is_banned: boolean;
                }>(
                  `
                    INSERT INTO users (organization_id, email, name, avatar_url, is_admin, wallet_balance)
                    VALUES ($1, $2, $3, $4, $5, '100.00')
                    RETURNING id, organization_id, email, name, avatar_url, wallet_balance, is_admin, is_banned
                  `,
                  [
                    organizationId,
                    email,
                    name,
                    resolveAvatarUrl({
                      avatarUrl,
                      name,
                      email
                    }),
                    shouldGrantAdmin
                  ]
                )
              ).rows[0];
            } catch (error) {
              if (
                error &&
                typeof error === "object" &&
                "code" in error &&
                error.code === "23505"
              ) {
                const conflictedUser = await loadUserByOrganizationEmail();
                if (conflictedUser.rowCount === 1) {
                  return conflictedUser.rows[0];
                }
              }

              throw error;
            }
          })();

    await client.query(
      `
        INSERT INTO oauth_accounts (user_id, provider, provider_uid, email, organization_id)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (organization_id, provider, provider_uid) DO NOTHING
      `,
      [user.id, provider, providerUid, email, organizationId]
    );

    return user;
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
}): Promise<SessionResult> {
  if (user.is_banned) {
    return { status: 403, body: { message: "User account is banned" } };
  }

  const session = await createSession({
    id: user.id,
    organization_id: user.organization_id,
    email: user.email,
    is_admin: user.is_admin,
    is_banned: user.is_banned
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

    if (!organizationSlug) {
      return reply.redirect(buildFrontendErrorUrl("Missing organization slug."));
    }

    let organizationId: string;

    try {
      organizationId = await lookupOrganizationIdBySlug(organizationSlug);
    } catch (error) {
      return reply.redirect(buildFrontendErrorUrl(error instanceof Error ? error.message : "Organization not found."));
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
      return reply.redirect(buildFrontendErrorUrl(`Google login failed: ${error}`));
    }

    if (!code || !state) {
      return reply.redirect(buildFrontendErrorUrl("Missing Google OAuth code or state."));
    }

    const rawState = await redis.get(authStateKey(state));
    if (!rawState) {
      return reply.redirect(buildFrontendErrorUrl("Google OAuth state is invalid or expired."));
    }

    await redis.del(authStateKey(state));
    const parsedState = JSON.parse(rawState) as GoogleOauthStatePayload;

    try {
      const profile = await exchangeGoogleAuthorizationCode(code);
      const organizationId = parsedState.organization_id;

      const user = await resolveUserFromOauth({
        organizationId,
        provider: "google",
        providerUid: profile.providerUid,
        email: profile.email,
        name: profile.name,
        avatarUrl: profile.avatarUrl
      });

      const sessionResult = await issueSessionForUser(user);

      if (sessionResult.status !== 200) {
        return reply.code(sessionResult.status).send(sessionResult.body);
      }

      setRefreshCookie(reply, sessionResult.session.refreshToken);
      return reply.redirect(buildFrontendAuthCallbackUrl(parsedState.redirect_to));
    } catch (oauthError) {
      return reply.redirect(buildFrontendErrorUrl(oauthError instanceof Error ? oauthError.message : "Google OAuth failed"));
    }
  });

  app.post("/auth/email-login", async (request, reply) => {
    if (process.env.NODE_ENV === "production") {
      return reply.code(404).send({ message: "Not found" });
    }

    const body = emailLoginSchema.parse(request.body);
    const email = body.email.trim().toLowerCase();
    const organizationId = await requireResolvedOrganizationId(request);

    console.log("EMAIL_LOGIN_REQUEST", {
      organizationId,
      email
    });

    const user = await resolveUserFromOauth({
      organizationId,
      provider: "google",
      providerUid: makeDevProviderUid(email),
      email,
      name: body.name?.trim() ?? email.split("@")[0],
      avatarUrl: body.avatar_url ?? null
    });

    const sessionResult = await issueSessionForUser(user);

    if (sessionResult.status !== 200) {
      return reply.code(sessionResult.status).send(sessionResult.body);
    }

    setRefreshCookie(reply, sessionResult.session.refreshToken);

    return {
      access_token: sessionResult.session.accessToken,
      user,
      mode: "email_only"
    };
  });

  app.post("/auth/request-code", async (request, reply) => {
    if (process.env.NODE_ENV === "production") {
      return reply.code(404).send({ message: "Not found" });
    }

    const body = requestCodeSchema.parse(request.body);
    const email = body.email.trim().toLowerCase();
    const organizationId = await requireResolvedOrganizationId(request);

    const code = String(randomInt(100000, 999999));

    const payload: AuthCodePayload = {
      code,
      name: body.name?.trim(),
      avatar_url: body.avatar_url
    };

    await redis.setex(
      authCodeKey(organizationId, email),
      config.authCodeTtlMinutes * 60,
      JSON.stringify(payload)
    );

    return {
      success: true,
      email,
      expires_in_minutes: config.authCodeTtlMinutes,
      dev_code: process.env.NODE_ENV === "production" ? undefined : config.authDevCode || code
    };
  });

  app.post("/auth/password-login", async (request, reply) => {
    if (process.env.NODE_ENV === "production") {
      return reply.code(404).send({ message: "Not found" });
    }

    const body = passwordSchema.parse(request.body);
    const email = body.email.trim().toLowerCase();
    const organizationId = await requireResolvedOrganizationId(request);

    const password = body.password.trim();
    const patternOk = /^quiz@\d{4}$/i.test(password);

    if (password !== config.authDevPassword && !patternOk) {
      return reply.code(401).send({ message: "Invalid password" });
    }

    const user = await resolveUserFromOauth({
      organizationId,
      provider: "google",
      providerUid: makeDevProviderUid(email),
      email,
      name: body.name?.trim() ?? email.split("@")[0],
      avatarUrl: body.avatar_url ?? null
    });

    const sessionResult = await issueSessionForUser(user);

    if (sessionResult.status !== 200) {
      return reply.code(sessionResult.status).send(sessionResult.body);
    }

    setRefreshCookie(reply, sessionResult.session.refreshToken);

    return {
      access_token: sessionResult.session.accessToken,
      user,
      mode: "password_auth"
    };
  });

  app.post("/auth/verify-code", async (request, reply) => {
    if (process.env.NODE_ENV === "production") {
      return reply.code(404).send({ message: "Not found" });
    }

    const body = verifyCodeSchema.parse(request.body);
    const email = body.email.trim().toLowerCase();
    const organizationId = await requireResolvedOrganizationId(request);

    const raw = await redis.get(authCodeKey(organizationId, email));
    if (!raw) {
      return reply.code(401).send({ message: "Code expired or not requested" });
    }

    const parsed: AuthCodePayload = JSON.parse(raw);
    const expectedCode = config.authDevCode || parsed.code;

    if (body.code !== expectedCode) {
      return reply.code(401).send({ message: "Invalid code" });
    }

    await redis.del(authCodeKey(organizationId, email));

    const user = await resolveUserFromOauth({
      organizationId,
      provider: "google",
      providerUid: makeDevProviderUid(email),
      email,
      name: parsed.name ?? email.split("@")[0],
      avatarUrl: parsed.avatar_url ?? null
    });

    const sessionResult = await issueSessionForUser(user);

    if (sessionResult.status !== 200) {
      return reply.code(sessionResult.status).send(sessionResult.body);
    }

    setRefreshCookie(reply, sessionResult.session.refreshToken);

    return {
      access_token: sessionResult.session.accessToken,
      user,
      mode: "code_auth",
      comment: "Temporary code-based auth enabled because Google OAuth credentials are missing."
    };
  });

  app.post("/auth/google", async (request, reply) => {
    await enforceRateLimit(request, {
      scope: "auth-google-direct",
      limit: 10,
      windowSec: 60
    });

    if (process.env.NODE_ENV === "production") {
      return reply.code(404).send({ message: "Not found" });
    }

    const body = googleSchema.parse(request.body);
    const organizationId = await requireResolvedOrganizationId(request);

    try {
      const profile = await verifyGoogleIdToken(body.id_token);
      const user = await resolveUserFromOauth({
        organizationId,
        provider: "google",
        providerUid: profile.providerUid,
        email: profile.email,
        name: profile.name,
        avatarUrl: profile.avatarUrl
      });

      const sessionResult = await issueSessionForUser(user);

      if (sessionResult.status !== 200) {
        return reply.code(sessionResult.status).send(sessionResult.body);
      }

      setRefreshCookie(reply, sessionResult.session.refreshToken);

      return {
        access_token: sessionResult.session.accessToken,
        user,
        mode: "google_oauth"
      };
    } catch (error) {
      return reply.code(503).send({
        message:
          error instanceof Error
            ? error.message
            : "Google OAuth is not configured or token validation failed"
      });
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
    user: request.user
  }));
}
