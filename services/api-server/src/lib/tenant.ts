import type { FastifyRequest } from "fastify";
import { z } from "zod";

const organizationIdSchema = z.uuid();

function invalidOrganizationIdError(message: string) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

export function parseOrganizationId(value: string | undefined) {
  const parsed = organizationIdSchema.safeParse(value?.trim());
  return parsed.success ? parsed.data : null;
}

export function requireOrganizationId(request: FastifyRequest) {
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
