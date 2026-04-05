import { pool } from "@quiz-app/db";
import type { FastifyRequest } from "fastify";
import { z } from "zod";

const organizationIdSchema = z.uuid();
const organizationSlugSchema = z.string().trim().min(2).max(48).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

function invalidOrganizationIdError(message: string) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function invalidOrganizationSlugError(message: string) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

export function parseOrganizationId(value: string | undefined) {
  const parsed = organizationIdSchema.safeParse(value?.trim());
  return parsed.success ? parsed.data : null;
}

export function parseOrganizationSlug(value: string | undefined) {
  const parsed = organizationSlugSchema.safeParse(value?.trim().toLowerCase());
  return parsed.success ? parsed.data : null;
}

function readHeaderValue(request: FastifyRequest, headerName: string) {
  const headerValue = request.headers[headerName];
  return typeof headerValue === "string"
    ? headerValue
    : Array.isArray(headerValue)
      ? headerValue[0]
      : undefined;
}

function readQueryValue(request: FastifyRequest, key: string) {
  const query = (request.query ?? {}) as Record<string, unknown>;
  const value = query[key];
  return typeof value === "string" ? value : undefined;
}

function readBodyValue(request: FastifyRequest, key: string) {
  const body = request.body;

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }

  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

export function getOrganizationIdFromRequest(request: FastifyRequest) {
  const headerValue = request.headers["x-organization-id"];
  const organizationId = typeof headerValue === "string"
    ? headerValue
    : Array.isArray(headerValue)
      ? headerValue[0]
      : undefined;

  if (!organizationId) {
    throw invalidOrganizationIdError("Missing x-organization-id header");
  }

  const parsedOrganizationId = parseOrganizationId(organizationId);
  if (!parsedOrganizationId) {
    throw invalidOrganizationIdError("Invalid x-organization-id header");
  }

  return parsedOrganizationId;
}

export function getOrganizationSlugFromRequest(request: FastifyRequest) {
  const candidates = [
    readHeaderValue(request, "x-organization-slug"),
    readQueryValue(request, "organization"),
    readQueryValue(request, "organization_slug"),
    readQueryValue(request, "slug"),
    readBodyValue(request, "organization"),
    readBodyValue(request, "organization_slug"),
    readBodyValue(request, "slug")
  ];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    const parsed = parseOrganizationSlug(candidate);
    if (!parsed) {
      throw invalidOrganizationSlugError("Invalid organization slug");
    }

    return parsed;
  }

  return null;
}

export async function lookupOrganizationIdBySlug(slug: string) {
  const parsedSlug = parseOrganizationSlug(slug);
  if (!parsedSlug) {
    throw invalidOrganizationSlugError("Invalid organization slug");
  }

  const result = await pool.query<{ id: string }>(
    `
      SELECT id
      FROM organizations
      WHERE slug = $1
      LIMIT 1
    `,
    [parsedSlug]
  );

  if (result.rowCount !== 1) {
    throw Object.assign(new Error("Organization not found"), { statusCode: 404 });
  }

  return result.rows[0].id;
}

export async function requireResolvedOrganizationId(request: FastifyRequest) {
  const directOrganizationId = parseOrganizationId(readHeaderValue(request, "x-organization-id"));
  if (directOrganizationId) {
    return directOrganizationId;
  }

  const organizationSlug = getOrganizationSlugFromRequest(request);
  if (organizationSlug) {
    return lookupOrganizationIdBySlug(organizationSlug);
  }

  throw invalidOrganizationIdError("Missing tenant context. Provide organization slug.");
}
