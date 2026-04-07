import { pool, withTransaction } from "@quiz-app/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { authenticate, requireRole, requireSuperAdmin, PLATFORM_GLOBAL_ORG_ID } from "../lib/auth.js";
import { writeAuditLog } from "../lib/audit.js";

const joinOrganizationSchema = z.object({
  organization: z.string().trim().min(2).max(80),
  employee_id: z.string().trim().min(2).max(64)
});

const createOrganizationSchema = z.object({
  name: z.string().trim().min(2).max(80),
  slug: z.string().trim().min(2).max(48).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  admin_email: z.string().email()
});

const approveMembershipSchema = z.object({
  membership_id: z.uuid(),
  role: z.enum(["organization_admin", "player"]),
  action: z.enum(["approve", "reject"])
});
const updateOrganizationSchema = z.object({
  name: z.string().trim().min(2).max(80),
  slug: z.string().trim().min(2).max(48).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  admin_email: z.string().email()
});

export async function saasRoutes(app: FastifyInstance) {
  app.post("/join-organization", { preHandler: authenticate }, async (request, reply) => {
    const body = joinOrganizationSchema.parse(request.body);

    if (request.user.role === "super_admin") {
      return reply.code(403).send({ message: "Super admins do not join tenant organizations" });
    }

    const organizationLookup = await pool.query<{
      id: string;
      slug: string;
      name: string;
      is_active: boolean;
    }>(
      `
        SELECT id, slug, name, is_active
        FROM organizations
        WHERE slug = LOWER($1)
           OR LOWER(name) = LOWER($1)
        LIMIT 1
      `,
      [body.organization]
    );

    if (organizationLookup.rowCount !== 1) {
      return reply.code(404).send({ message: "Organization not found" });
    }

    const organization = organizationLookup.rows[0];

    if (!organization.is_active) {
      return reply.code(403).send({ message: "Organization inactive" });
    }

    const membership = await withTransaction(async (client) => {
      const result = await client.query<{
        id: string;
        status: "pending" | "approved" | "rejected";
      }>(
        `
          INSERT INTO memberships (user_id, organization_id, role, employee_id, status, updated_at)
          VALUES ($1, $2, 'player', $3, 'pending', NOW())
          ON CONFLICT (user_id, organization_id) DO UPDATE
          SET employee_id = EXCLUDED.employee_id,
              status = 'pending',
              role = 'player',
              updated_at = NOW()
          RETURNING id, status
        `,
        [request.user.id, organization.id, body.employee_id]
      );

      await client.query(
        `
          UPDATE users
          SET organization_id = $2,
              status = 'pending',
              is_admin = FALSE,
              updated_at = NOW()
          WHERE id = $1
            AND organization_id = $3
        `,
        [request.user.id, PLATFORM_GLOBAL_ORG_ID, request.user.organization_id]
      );

      return result.rows[0];
    });

    await writeAuditLog({
      actorUserId: request.user.id,
      organizationId: organization.id,
      action: "membership.requested",
      targetType: "membership",
      targetId: membership.id,
      metadata: {
        employee_id: body.employee_id,
        organization_slug: organization.slug
      }
    });

    return {
      success: true,
      membership: {
        id: membership.id,
        status: membership.status,
        organization
      }
    };
  });

  app.get("/admin/pending-users", { preHandler: requireRole(["super_admin", "organization_admin"]) }, async (request) => {
    const result = await pool.query<{
      membership_id: string;
      user_id: string;
      email: string;
      name: string;
      organization_id: string;
      organization_name: string;
      organization_slug: string;
      employee_id: string;
      created_at: string;
    }>(
      `
        SELECT
          m.id AS membership_id,
          u.id AS user_id,
          u.email,
          u.name,
          o.id AS organization_id,
          o.name AS organization_name,
          o.slug AS organization_slug,
          m.employee_id,
          m.created_at
        FROM memberships m
        JOIN users u ON u.id = m.user_id
        JOIN organizations o ON o.id = m.organization_id
        WHERE m.status = 'pending'
          AND ($1 = 'super_admin' OR m.organization_id = $2)
        ORDER BY m.created_at ASC
      `,
      [request.user.role, request.user.organization_id]
    );

    return { pending_users: result.rows };
  });

  app.post("/admin/approve-user", { preHandler: requireRole(["super_admin", "organization_admin"]) }, async (request, reply) => {
    const body = approveMembershipSchema.parse(request.body);

    const result = await withTransaction(async (client) => {
      const membershipResult = await client.query<{
        id: string;
        user_id: string;
        organization_id: string;
        status: "pending" | "approved" | "rejected";
      }>(
        `
          SELECT id, user_id, organization_id, status
          FROM memberships
          WHERE id = $1
          FOR UPDATE
        `,
        [body.membership_id]
      );

      if (membershipResult.rowCount !== 1) {
        return null;
      }

      const membership = membershipResult.rows[0];

      if (request.user.role === "organization_admin" && membership.organization_id !== request.user.organization_id) {
        return { forbidden: true as const };
      }

      if (request.user.role === "organization_admin" && body.role === "organization_admin") {
        return { forbidden: true as const };
      }

      if (body.action === "reject") {
        await client.query(
          `
            UPDATE memberships
            SET status = 'rejected',
                updated_at = NOW(),
                approved_by = $2
            WHERE id = $1
          `,
          [body.membership_id, request.user.id]
        );

        await client.query(
          `
            UPDATE users
            SET status = 'pending',
                organization_id = $2,
                updated_at = NOW()
            WHERE id = $1
          `,
          [membership.user_id, PLATFORM_GLOBAL_ORG_ID]
        );

        return {
          action: "rejected" as const,
          membership
        };
      }

      await client.query(
        `
          UPDATE memberships
          SET status = 'approved',
              role = $2,
              approved_by = $3,
              approved_at = NOW(),
              updated_at = NOW()
          WHERE id = $1
        `,
        [body.membership_id, body.role, request.user.id]
      );

      await client.query(
        `
          UPDATE users
          SET organization_id = $2,
              status = 'active',
              is_admin = $3,
              updated_at = NOW()
          WHERE id = $1
        `,
        [membership.user_id, membership.organization_id, body.role === "organization_admin"]
      );

      return {
        action: "approved" as const,
        membership
      };
    });

    if (result && "forbidden" in result) {
      return reply.code(403).send({ message: "Not allowed to review this membership" });
    }

    if (!result) {
      return reply.code(404).send({ message: "Membership not found" });
    }

    await writeAuditLog({
      actorUserId: request.user.id,
      organizationId: result.membership.organization_id,
      action: result.action === "approved" ? "membership.approved" : "membership.rejected",
      targetType: "membership",
      targetId: result.membership.id,
      metadata: {
        membership_id: result.membership.id,
        action: result.action,
        assigned_role: body.action === "approve" ? body.role : null
      }
    });

    return { success: true, action: result.action };
  });

  app.post("/admin/create-organization", { preHandler: requireSuperAdmin }, async (request, reply) => {
    const body = createOrganizationSchema.parse(request.body);

    try {
      const result = await pool.query<{
        id: string;
        name: string;
        slug: string;
        is_active: boolean;
      }>(
        `
          INSERT INTO organizations (id, name, slug, admin_email, company_id, status, is_active)
          VALUES (gen_random_uuid(), $1, $2, $3, $4, 'active', TRUE)
          RETURNING id, name, slug, is_active
        `,
        [body.name, body.slug, body.admin_email.toLowerCase(), body.slug]
      );

      await writeAuditLog({
        actorUserId: request.user.id,
        organizationId: result.rows[0].id,
        action: "organization.created",
        targetType: "organization",
        targetId: result.rows[0].id,
        metadata: {
          slug: result.rows[0].slug
        }
      });

      return { organization: result.rows[0] };
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "23505") {
        return reply.code(409).send({ message: "Organization already exists" });
      }

      throw error;
    }
  });

  app.get("/admin/organizations", { preHandler: requireSuperAdmin }, async () => {
    const result = await pool.query<{
      id: string;
      name: string;
      slug: string;
      admin_email: string;
      is_active: boolean;
      created_at: string;
    }>(
      `
        SELECT id, name, slug, admin_email, is_active, created_at
        FROM organizations
        WHERE id <> $1
        ORDER BY created_at DESC
      `,
      [PLATFORM_GLOBAL_ORG_ID]
    );

    return { organizations: result.rows };
  });

  app.post("/admin/update-organization/:id", { preHandler: requireSuperAdmin }, async (request, reply) => {
    const organizationId = String((request.params as { id: string }).id);
    const body = updateOrganizationSchema.parse(request.body);

    const result = await pool.query<{
      id: string;
      name: string;
      slug: string;
      admin_email: string;
      is_active: boolean;
    }>(
      `
        UPDATE organizations
        SET name = $2,
            slug = $3,
            admin_email = $4,
            company_id = $3,
            updated_at = NOW()
        WHERE id = $1
        RETURNING id, name, slug, admin_email, is_active
      `,
      [organizationId, body.name, body.slug, body.admin_email.toLowerCase()]
    );

    if (result.rowCount !== 1) {
      return reply.code(404).send({ message: "Organization not found" });
    }

    await writeAuditLog({
      actorUserId: request.user.id,
      organizationId,
      action: "organization.updated",
      targetType: "organization",
      targetId: organizationId
    });

    return { organization: result.rows[0] };
  });

  app.post("/admin/toggle-organization", { preHandler: requireSuperAdmin }, async (request, reply) => {
    const body = z.object({
      organization_id: z.uuid(),
      is_active: z.boolean()
    }).parse(request.body);

    const result = await pool.query<{
      id: string;
      is_active: boolean;
    }>(
      `
        UPDATE organizations
        SET is_active = $2,
            updated_at = NOW()
        WHERE id = $1
        RETURNING id, is_active
      `,
      [body.organization_id, body.is_active]
    );

    if (result.rowCount !== 1) {
      return reply.code(404).send({ message: "Organization not found" });
    }

    await writeAuditLog({
      actorUserId: request.user.id,
      organizationId: body.organization_id,
      action: body.is_active ? "organization.activated" : "organization.deactivated",
      targetType: "organization",
      targetId: body.organization_id
    });

    return { organization: result.rows[0] };
  });

  app.post("/admin/organizations/:id/status", { preHandler: requireSuperAdmin }, async (request, reply) => {
    const organizationId = String((request.params as { id: string }).id);
    const body = z.object({ is_active: z.boolean() }).parse(request.body);

    const result = await pool.query<{
      id: string;
      is_active: boolean;
    }>(
      `
        UPDATE organizations
        SET is_active = $2,
            updated_at = NOW()
        WHERE id = $1
        RETURNING id, is_active
      `,
      [organizationId, body.is_active]
    );

    if (result.rowCount !== 1) {
      return reply.code(404).send({ message: "Organization not found" });
    }

    await writeAuditLog({
      actorUserId: request.user.id,
      organizationId,
      action: body.is_active ? "organization.activated" : "organization.deactivated",
      targetType: "organization",
      targetId: organizationId
    });

    return { organization: result.rows[0] };
  });

  app.delete("/admin/organizations/:id", { preHandler: requireSuperAdmin }, async (request, reply) => {
    const organizationId = String((request.params as { id: string }).id);

    const dependentUsers = await pool.query<{ count: string }>(
      `
        SELECT COUNT(*)::text AS count
        FROM users
        WHERE organization_id = $1
      `,
      [organizationId]
    );

    if (Number(dependentUsers.rows[0]?.count ?? 0) > 0) {
      return reply.code(409).send({ message: "Cannot delete organization with users attached" });
    }

    const result = await pool.query<{ id: string }>(
      `
        DELETE FROM organizations
        WHERE id = $1
          AND id <> $2
        RETURNING id
      `,
      [organizationId, PLATFORM_GLOBAL_ORG_ID]
    );

    if (result.rowCount !== 1) {
      return reply.code(404).send({ message: "Organization not found" });
    }

    await writeAuditLog({
      actorUserId: request.user.id,
      organizationId,
      action: "organization.deleted",
      targetType: "organization",
      targetId: organizationId
    });

    return { success: true };
  });

  app.get("/admin/system/users", { preHandler: requireSuperAdmin }, async () => {
    const result = await pool.query<{
      id: string;
      email: string;
      name: string;
      status: string;
      organization_id: string;
      created_at: string;
    }>(
      `
        SELECT id, email, name, status, organization_id, created_at
        FROM users
        ORDER BY created_at DESC
      `
    );

    return { users: result.rows };
  });

  app.get("/admin/system/activity", { preHandler: requireSuperAdmin }, async () => {
    const result = await pool.query<{
      id: string;
      action: string;
      target_type: string;
      target_id: string | null;
      created_at: string;
      metadata: Record<string, unknown>;
    }>(
      `
        SELECT id, action, target_type, target_id, created_at, metadata
        FROM audit_logs
        ORDER BY created_at DESC
        LIMIT 100
      `
    );

    return { activity: result.rows };
  });
}
