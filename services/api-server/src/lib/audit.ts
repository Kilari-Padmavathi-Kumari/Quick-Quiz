import { pool } from "@quiz-app/db";

export async function writeAuditLog(input: {
  actorUserId?: string | null;
  organizationId?: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
}) {
  await pool.query(
    `
      INSERT INTO audit_logs (actor_user_id, organization_id, action, target_type, target_id, metadata)
      VALUES ($1, $2, $3, $4, $5, $6)
    `,
    [
      input.actorUserId ?? null,
      input.organizationId ?? null,
      input.action,
      input.targetType,
      input.targetId ?? null,
      JSON.stringify(input.metadata ?? {})
    ]
  );
}
