import { pool } from "@quiz-app/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { config } from "../env.js";
import { enforceRateLimit } from "../lib/rate-limit.js";

export function normalizeOrganizationSlug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

async function makeUniqueOrganizationSlug(baseName: string) {
  const normalizedBase = normalizeOrganizationSlug(baseName) || "organization";

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = attempt === 0 ? normalizedBase : `${normalizedBase}-${attempt + 1}`;
    const existing = await pool.query<{ id: string }>(
      "SELECT id FROM organizations WHERE slug = $1 LIMIT 1",
      [candidate]
    );

    if (existing.rowCount === 0) {
      return candidate;
    }
  }

  return `${normalizedBase}-${Date.now().toString(36)}`;
}

const createOrganizationSchema = z.object({
  name: z.string().min(2).max(80),
  admin_email: z.string().email(),
  slug: z.string().min(2).max(48).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional()
});

async function findOrganizationSuggestions(input: { normalizedSlug: string; rawName?: string }) {
  const slugLikePattern = `%${input.normalizedSlug.replace(/-/g, "%")}%`;
  const nameLikePattern = `%${(input.rawName?.trim() ?? input.normalizedSlug).replace(/\s+/g, "%")}%`;

  const result = await pool.query<{
    id: string;
    name: string;
    slug: string;
    created_at: string;
    admin_email: string;
    score: number;
  }>(
    `
      SELECT
        id,
        name,
        slug,
        created_at,
        admin_email,
        GREATEST(
          similarity(slug, $1),
          similarity(LOWER(name), LOWER($2))
        ) AS score
      FROM organizations
      WHERE slug % $1
         OR LOWER(name) % LOWER($2)
         OR slug ILIKE $3
         OR name ILIKE $4
      ORDER BY score DESC, name ASC
      LIMIT 5
    `,
    [input.normalizedSlug, input.rawName?.trim() ?? input.normalizedSlug, slugLikePattern, nameLikePattern]
  );

  return result.rows.map(({ score: _score, ...organization }) => organization);
}

export async function organizationRoutes(app: FastifyInstance) {
  app.get("/organizations/lookup", async (request, reply) => {
    await enforceRateLimit(request, {
      scope: "organizations-lookup",
      limit: 30,
      windowSec: 60
    });

    const query = z.object({
      slug: z.string().min(1).max(80).optional(),
      name: z.string().min(2).max(80).optional(),
      id: z.uuid().optional()
    }).parse(request.query);

    if (!query.slug && !query.id && !query.name) {
      return reply.code(400).send({ message: "Provide organization slug, name, or id" });
    }

    const normalizedSlug =
      query.slug
        ? normalizeOrganizationSlug(query.slug)
        : query.name
          ? normalizeOrganizationSlug(query.name)
          : null;

    const result = await pool.query<{
      id: string;
      name: string;
      slug: string;
      created_at: string;
      admin_email: string;
    }>(
      `
        SELECT id, name, slug, created_at, admin_email
        FROM organizations
        WHERE ($1::citext IS NOT NULL AND slug = $1)
           OR ($2::uuid IS NOT NULL AND id = $2)
           OR ($3::citext IS NOT NULL AND LOWER(name) = LOWER($3))
        LIMIT 1
      `,
      [normalizedSlug ?? null, query.id ?? null, query.name?.trim() ?? null]
    );

    if (result.rowCount !== 1) {
      const suggestions = normalizedSlug
        ? await findOrganizationSuggestions({
            normalizedSlug,
            rawName: query.name ?? query.slug
          })
        : [];

      return reply.code(404).send({
        message: "Organization not found",
        normalized_slug: normalizedSlug,
        suggestions
      });
    }

    return {
      organization: result.rows[0],
      normalized_slug: normalizedSlug ?? result.rows[0].slug
    };
  });

  app.post("/organizations", async (request, reply) => {
    const body = createOrganizationSchema.parse(request.body);
    const slug = body.slug ? normalizeOrganizationSlug(body.slug) : await makeUniqueOrganizationSlug(body.name);

    if (!slug) {
      return reply.code(422).send({ message: "Organization slug could not be generated" });
    }

    const result = await pool.query<{
      id: string;
      name: string;
      slug: string;
      admin_email: string;
      created_at: string;
    }>(
      `
        INSERT INTO organizations (id, name, slug, admin_email)
        VALUES (gen_random_uuid(), $1, $2, $3)
        RETURNING id, name, slug, admin_email, created_at
      `,
      [body.name.trim(), slug, body.admin_email.trim().toLowerCase()]
    );

    return reply.code(201).send({
      organization: result.rows[0],
      onboarding: {
        login_url: `${config.frontendUrl}/?organization=${result.rows[0].slug}`
      }
    });
  });
}
