ALTER TABLE refresh_tokens
  ADD COLUMN IF NOT EXISTS organization_id UUID;

ALTER TABLE contest_members
  ADD COLUMN IF NOT EXISTS organization_id UUID;

ALTER TABLE answers
  ADD COLUMN IF NOT EXISTS organization_id UUID;

UPDATE refresh_tokens rt
SET organization_id = u.organization_id
FROM users u
WHERE rt.user_id = u.id
  AND rt.organization_id IS NULL;

UPDATE contest_members cm
SET organization_id = c.organization_id
FROM contests c
WHERE cm.contest_id = c.id
  AND cm.organization_id IS NULL;

UPDATE answers a
SET organization_id = c.organization_id
FROM contests c
WHERE a.contest_id = c.id
  AND a.organization_id IS NULL;

ALTER TABLE refresh_tokens
  ALTER COLUMN organization_id SET NOT NULL;

ALTER TABLE contest_members
  ALTER COLUMN organization_id SET NOT NULL;

ALTER TABLE answers
  ALTER COLUMN organization_id SET NOT NULL;

ALTER TABLE refresh_tokens
  ADD CONSTRAINT refresh_tokens_user_org_fkey
  FOREIGN KEY (user_id, organization_id)
  REFERENCES users (id, organization_id)
  ON DELETE CASCADE;

ALTER TABLE contest_members
  ADD CONSTRAINT contest_members_user_org_fkey
  FOREIGN KEY (user_id, organization_id)
  REFERENCES users (id, organization_id)
  ON DELETE CASCADE;

ALTER TABLE contest_members
  ADD CONSTRAINT contest_members_contest_org_fkey
  FOREIGN KEY (contest_id, organization_id)
  REFERENCES contests (id, organization_id)
  ON DELETE CASCADE;

ALTER TABLE answers
  ADD CONSTRAINT answers_user_org_fkey
  FOREIGN KEY (user_id, organization_id)
  REFERENCES users (id, organization_id)
  ON DELETE CASCADE;

ALTER TABLE answers
  ADD CONSTRAINT answers_contest_org_fkey
  FOREIGN KEY (contest_id, organization_id)
  REFERENCES contests (id, organization_id)
  ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS refresh_tokens_user_org_idx
  ON refresh_tokens (user_id, organization_id, expires_at);

CREATE INDEX IF NOT EXISTS contest_members_contest_org_user_idx
  ON contest_members (contest_id, organization_id, user_id);

CREATE INDEX IF NOT EXISTS answers_contest_org_question_user_idx
  ON answers (contest_id, organization_id, question_id, user_id);
