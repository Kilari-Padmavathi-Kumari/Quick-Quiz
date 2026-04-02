import { createHash, randomBytes } from "node:crypto";

import type { FastifyReply, FastifyRequest } from "fastify";
import { SignJWT, jwtVerify } from "jose";

import { pool, withTransaction } from "@quiz-app/db";
import type { PoolClient } from "pg";

import { config } from "../env.js";
import { normalizeOrganizationId } from "./tenant.js";

const REFRESH_COOKIE = "quiz_refresh";
const jwtKey = new TextEncoder().encode(config.jwtSecret);

export type SessionIdentity = {
  id: string;
  organization_id: string;
  email: string;
  is_admin: boolean;
  is_banned: boolean;
};

export function getRefreshCookieName() {
  return REFRESH_COOKIE;
}

function sha256Hex(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

async function signAccessToken(user: SessionIdentity) {
  return new SignJWT({
    user_id: user.id,
    organization_id: user.organization_id,
    email: user.email,
    is_admin: user.is_admin,
    is_banned: user.is_banned
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setIssuer(config.jwtIssuer)
    .setAudience(config.jwtAudience)
    .setExpirationTime(`${config.accessTokenTtlMinutes}m`)
    .sign(jwtKey);
}

async function insertRefreshToken(client: PoolClient, userId: string) {
  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = sha256Hex(rawToken);
  const expiresAt = new Date(Date.now() + config.refreshTokenTtlDays * 24 * 60 * 60 * 1000);

  await client.query(
    "INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)",
    [userId, tokenHash, expiresAt]
  );

  return { rawToken, expiresAt };
}

export async function createSession(user: SessionIdentity) {
  return withTransaction(async (client) => {
    const refresh = await insertRefreshToken(client, user.id);

    return {
      accessToken: await signAccessToken(user),
      refreshToken: refresh.rawToken
    };
  });
}

export async function rotateSession(rawRefreshToken: string) {
  const tokenHash = sha256Hex(rawRefreshToken);

  return withTransaction(async (client) => {
    const result = await client.query<{
      id: string;
      user_id: string;
      organization_id: string;
      expires_at: string;
      revoked_at: string | null;
      email: string;
      is_admin: boolean;
      is_banned: boolean;
    }>(
      `
        SELECT
          rt.id,
          rt.user_id,
          u.organization_id,
          rt.expires_at,
          rt.revoked_at,
          u.email,
          u.is_admin,
          u.is_banned
        FROM refresh_tokens rt
        JOIN users u ON u.id = rt.user_id
        WHERE rt.token_hash = $1
        LIMIT 1
      `,
      [tokenHash]
    );

    if (result.rowCount !== 1) {
      return null;
    }

    const tokenRow = result.rows[0];
    if (tokenRow.revoked_at || new Date(tokenRow.expires_at).getTime() < Date.now()) {
      return null;
    }

    await client.query("UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = $1", [tokenRow.id]);
    const refresh = await insertRefreshToken(client, tokenRow.user_id);

    return {
      accessToken: await signAccessToken({
        id: tokenRow.user_id,
        organization_id: tokenRow.organization_id,
        email: tokenRow.email,
        is_admin: tokenRow.is_admin,
        is_banned: tokenRow.is_banned
      }),
      refreshToken: refresh.rawToken
    };
  });
}

export async function revokeRefreshToken(rawRefreshToken: string) {
  const tokenHash = sha256Hex(rawRefreshToken);
  await pool.query(
    "UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = $1 AND revoked_at IS NULL",
    [tokenHash]
  );
}

export function setRefreshCookie(reply: FastifyReply, rawRefreshToken: string) {
  reply.setCookie(REFRESH_COOKIE, rawRefreshToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.cookieSecure,
    path: "/",
    ...(config.cookieDomain ? { domain: config.cookieDomain } : {}),
    expires: new Date(Date.now() + config.refreshTokenTtlDays * 24 * 60 * 60 * 1000)
  });
}

export function clearRefreshCookie(reply: FastifyReply) {
  reply.clearCookie(REFRESH_COOKIE, {
    path: "/",
    ...(config.cookieDomain ? { domain: config.cookieDomain } : {})
  });
}

async function loadUserForToken(userId: string, organizationId: string) {
  const result = await pool.query<FastifyRequest["user"]>(
    `
      SELECT id, organization_id, email, name, avatar_url, wallet_balance, is_admin, is_banned
      FROM users
      WHERE id = $1 AND organization_id = $2
      LIMIT 1
    `,
    [userId, organizationId]
  );

  return result.rowCount === 1 ? result.rows[0] : null;
}

export async function authenticateAccessToken(token: string, expectedOrganizationId?: string) {
  if (!token) {
    return { user: null, error: "Missing Bearer token" as const };
  }

  try {
    const { payload } = await jwtVerify(token, jwtKey, {
      issuer: config.jwtIssuer,
      audience: config.jwtAudience
    });

    const rawOrganizationId = String(payload.organization_id ?? "");
    if (!rawOrganizationId) {
      return { user: null, error: "Token is missing organization context" as const };
    }

    const organizationId = normalizeOrganizationId(rawOrganizationId);
    if (organizationId !== rawOrganizationId) {
      return { user: null, error: "Token organization is invalid" as const };
    }

    if (expectedOrganizationId && organizationId !== expectedOrganizationId) {
      return { user: null, error: "Organization mismatch" as const };
    }

    const user = await loadUserForToken(String(payload.user_id), organizationId);

    if (!user) {
      return { user: null, error: "User not found" as const };
    }

    if (user.is_banned) {
      return { user: null, error: "User account is banned" as const };
    }

    return { user, error: null };
  } catch {
    return { user: null, error: "Invalid or expired access token" as const };
  }
}

export async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  const header = request.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  const organizationHeader = request.headers["x-organization-id"];
  const rawExpectedOrganizationId =
    typeof organizationHeader === "string"
      ? organizationHeader
      : Array.isArray(organizationHeader)
        ? organizationHeader[0]
        : "";

  if (!rawExpectedOrganizationId) {
    return reply.code(400).send({ message: "Missing x-organization-id header" });
  }

  const expectedOrganizationId = normalizeOrganizationId(rawExpectedOrganizationId);
  const result = await authenticateAccessToken(token, expectedOrganizationId);

  if (!result.user) {
    if (result.error === "User account is banned") {
      return reply.code(403).send({ message: result.error });
    }

    request.log.warn({ error: result.error }, "Access token verification failed");
    return reply.code(401).send({ message: result.error });
  }

  request.user = result.user;
  return undefined;
}

export async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  const authResult = await authenticate(request, reply);
  if (authResult) {
    return authResult;
  }

  if (!request.user.is_admin) {
    return reply.code(403).send({ message: "Admin access required" });
  }
}

export function hashRefreshToken(rawToken: string) {
  return sha256Hex(rawToken);
}
