import type { FastifyRequest } from "fastify";
import { z } from "zod";

import { config } from "../env.js";

const organizationIdSchema = z.uuid();

export function normalizeOrganizationId(value: string | undefined) {
  const parsed = organizationIdSchema.safeParse(value);
  return parsed.success ? parsed.data : config.defaultOrganizationId;
}

export function requireOrganizationId(request: FastifyRequest) {
  const headerValue = request.headers["x-organization-id"];
  const organizationId = typeof headerValue === "string"
    ? headerValue
    : Array.isArray(headerValue)
      ? headerValue[0]
      : request.user?.organization_id;

  return normalizeOrganizationId(organizationId);
}
