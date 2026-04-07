ALTER TABLE memberships
  DROP CONSTRAINT IF EXISTS memberships_role_check;

ALTER TABLE memberships
  ADD CONSTRAINT memberships_role_check
  CHECK (role IN ('organization_admin', 'player'));

CREATE UNIQUE INDEX IF NOT EXISTS memberships_org_employee_id_uidx
  ON memberships (organization_id, employee_id);

CREATE TABLE IF NOT EXISTS quiz_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contest_id UUID NOT NULL REFERENCES contests(id) ON DELETE CASCADE,
  score INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, user_id, contest_id),
  CHECK (score >= 0)
);

CREATE INDEX IF NOT EXISTS quiz_attempts_org_user_idx
  ON quiz_attempts (organization_id, user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS quiz_attempts_org_contest_idx
  ON quiz_attempts (organization_id, contest_id, created_at DESC);
