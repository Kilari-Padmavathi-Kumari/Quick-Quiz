CREATE UNIQUE INDEX IF NOT EXISTS questions_id_org_uidx
  ON questions (id, organization_id);

ALTER TABLE answers
  DROP CONSTRAINT IF EXISTS answers_question_org_fkey;

ALTER TABLE answers
  ADD CONSTRAINT answers_question_org_fkey
  FOREIGN KEY (question_id, organization_id)
  REFERENCES questions (id, organization_id)
  ON DELETE CASCADE;

ALTER TABLE oauth_accounts
  DROP CONSTRAINT IF EXISTS oauth_accounts_user_org_fkey;

ALTER TABLE oauth_accounts
  ADD CONSTRAINT oauth_accounts_user_org_fkey
  FOREIGN KEY (user_id, organization_id)
  REFERENCES users (id, organization_id)
  ON DELETE CASCADE;

ALTER TABLE wallet_transactions
  DROP CONSTRAINT IF EXISTS wallet_transactions_user_org_fkey;

ALTER TABLE wallet_transactions
  ADD CONSTRAINT wallet_transactions_user_org_fkey
  FOREIGN KEY (user_id, organization_id)
  REFERENCES users (id, organization_id)
  ON DELETE CASCADE;

ALTER TABLE wallet_topup_requests
  DROP CONSTRAINT IF EXISTS wallet_topup_requests_user_org_fkey;

ALTER TABLE wallet_topup_requests
  ADD CONSTRAINT wallet_topup_requests_user_org_fkey
  FOREIGN KEY (user_id, organization_id)
  REFERENCES users (id, organization_id)
  ON DELETE CASCADE;
