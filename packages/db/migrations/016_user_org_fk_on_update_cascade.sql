ALTER TABLE refresh_tokens
  DROP CONSTRAINT IF EXISTS refresh_tokens_user_org_fkey;

ALTER TABLE refresh_tokens
  ADD CONSTRAINT refresh_tokens_user_org_fkey
  FOREIGN KEY (user_id, organization_id)
  REFERENCES users (id, organization_id)
  ON DELETE CASCADE
  ON UPDATE CASCADE;

ALTER TABLE contest_members
  DROP CONSTRAINT IF EXISTS contest_members_user_org_fkey;

ALTER TABLE contest_members
  ADD CONSTRAINT contest_members_user_org_fkey
  FOREIGN KEY (user_id, organization_id)
  REFERENCES users (id, organization_id)
  ON DELETE CASCADE
  ON UPDATE CASCADE;

ALTER TABLE answers
  DROP CONSTRAINT IF EXISTS answers_user_org_fkey;

ALTER TABLE answers
  ADD CONSTRAINT answers_user_org_fkey
  FOREIGN KEY (user_id, organization_id)
  REFERENCES users (id, organization_id)
  ON DELETE CASCADE
  ON UPDATE CASCADE;

ALTER TABLE oauth_accounts
  DROP CONSTRAINT IF EXISTS oauth_accounts_user_org_fkey;

ALTER TABLE oauth_accounts
  ADD CONSTRAINT oauth_accounts_user_org_fkey
  FOREIGN KEY (user_id, organization_id)
  REFERENCES users (id, organization_id)
  ON DELETE CASCADE
  ON UPDATE CASCADE;

ALTER TABLE wallet_transactions
  DROP CONSTRAINT IF EXISTS wallet_transactions_user_org_fkey;

ALTER TABLE wallet_transactions
  ADD CONSTRAINT wallet_transactions_user_org_fkey
  FOREIGN KEY (user_id, organization_id)
  REFERENCES users (id, organization_id)
  ON DELETE CASCADE
  ON UPDATE CASCADE;

ALTER TABLE wallet_topup_requests
  DROP CONSTRAINT IF EXISTS wallet_topup_requests_user_org_fkey;

ALTER TABLE wallet_topup_requests
  ADD CONSTRAINT wallet_topup_requests_user_org_fkey
  FOREIGN KEY (user_id, organization_id)
  REFERENCES users (id, organization_id)
  ON DELETE CASCADE
  ON UPDATE CASCADE;
