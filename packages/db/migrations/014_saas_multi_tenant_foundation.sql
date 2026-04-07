CREATE TABLE IF NOT EXISTS super_admins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email CITEXT NOT NULL UNIQUE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

CREATE UNIQUE INDEX IF NOT EXISTS organizations_name_uidx
  ON organizations (LOWER(name));

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';

UPDATE users
SET status = CASE
  WHEN is_banned = TRUE THEN 'blocked'
  ELSE 'active'
END
WHERE status NOT IN ('pending', 'active', 'blocked');

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_status_check;

ALTER TABLE users
  ADD CONSTRAINT users_status_check
  CHECK (status IN ('pending', 'active', 'blocked'));

INSERT INTO organizations (id, slug, name, admin_email, company_id, status, is_active)
VALUES (
  '00000000-0000-0000-0000-000000000000',
  'platform-global',
  'Platform Global',
  'platform@example.com',
  'platform-global',
  'active',
  TRUE
)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, organization_id),
  CHECK (role IN ('organization_admin', 'player')),
  CHECK (status IN ('pending', 'approved', 'rejected'))
);

CREATE INDEX IF NOT EXISTS memberships_org_status_idx
  ON memberships (organization_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS memberships_user_status_idx
  ON memberships (user_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_logs_org_created_idx
  ON audit_logs (organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS audit_logs_actor_created_idx
  ON audit_logs (actor_user_id, created_at DESC);

INSERT INTO memberships (user_id, organization_id, role, employee_id, status, approved_at, created_at, updated_at)
SELECT
  u.id,
  u.organization_id,
  CASE WHEN u.is_admin THEN 'organization_admin' ELSE 'player' END,
  CONCAT('legacy-', SUBSTRING(REPLACE(u.id::text, '-', '') FROM 1 FOR 8)),
  'approved',
  NOW(),
  COALESCE(u.created_at, NOW()),
  NOW()
FROM users u
WHERE u.organization_id <> '00000000-0000-0000-0000-000000000000'
ON CONFLICT (user_id, organization_id) DO NOTHING;
