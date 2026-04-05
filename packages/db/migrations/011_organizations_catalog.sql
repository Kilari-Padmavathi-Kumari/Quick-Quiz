CREATE TABLE IF NOT EXISTS organizations (
  id UUID PRIMARY KEY,
  slug CITEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  admin_email CITEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (char_length(name) >= 2),
  CHECK (char_length(slug) >= 2)
);

INSERT INTO organizations (id, slug, name, admin_email)
SELECT DISTINCT
  u.organization_id,
  CONCAT('org-', SUBSTRING(REPLACE(u.organization_id::text, '-', '') FROM 1 FOR 12)),
  CONCAT('Organization ', UPPER(SUBSTRING(REPLACE(u.organization_id::text, '-', '') FROM 1 FOR 6))),
  COALESCE(
    (
      SELECT admin_user.email
      FROM users admin_user
      WHERE admin_user.organization_id = u.organization_id
        AND admin_user.is_admin = true
      ORDER BY admin_user.created_at ASC
      LIMIT 1
    ),
    (
      SELECT first_user.email
      FROM users first_user
      WHERE first_user.organization_id = u.organization_id
      ORDER BY first_user.created_at ASC
      LIMIT 1
    ),
    'owner@example.com'
  )
FROM users u
ON CONFLICT (id) DO NOTHING;

CREATE INDEX IF NOT EXISTS organizations_name_idx
  ON organizations (name);
