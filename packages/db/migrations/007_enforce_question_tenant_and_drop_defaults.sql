ALTER TABLE users
  ALTER COLUMN organization_id DROP DEFAULT;

ALTER TABLE contests
  ALTER COLUMN organization_id DROP DEFAULT;

ALTER TABLE wallet_transactions
  ALTER COLUMN organization_id DROP DEFAULT;

ALTER TABLE wallet_topup_requests
  ALTER COLUMN organization_id DROP DEFAULT;

ALTER TABLE oauth_accounts
  ALTER COLUMN organization_id DROP DEFAULT;

ALTER TABLE questions
  ADD COLUMN IF NOT EXISTS organization_id UUID;

UPDATE questions q
SET organization_id = c.organization_id
FROM contests c
WHERE q.contest_id = c.id
  AND q.organization_id IS NULL;

ALTER TABLE questions
  ALTER COLUMN organization_id SET NOT NULL;

ALTER TABLE questions
  ADD CONSTRAINT questions_contest_org_fkey
  FOREIGN KEY (contest_id, organization_id)
  REFERENCES contests (id, organization_id)
  ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS questions_contest_org_seq_idx
  ON questions (contest_id, organization_id, seq);
