ALTER TABLE users
  ADD COLUMN IF NOT EXISTS organization_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001';

ALTER TABLE contests
  ADD COLUMN IF NOT EXISTS organization_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001';

ALTER TABLE wallet_transactions
  ADD COLUMN IF NOT EXISTS organization_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001';

ALTER TABLE wallet_topup_requests
  ADD COLUMN IF NOT EXISTS organization_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001';

ALTER TABLE oauth_accounts
  ADD COLUMN IF NOT EXISTS organization_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001';

UPDATE contests c
SET organization_id = u.organization_id
FROM users u
WHERE c.created_by = u.id
  AND c.organization_id = '00000000-0000-0000-0000-000000000001';

UPDATE wallet_transactions wt
SET organization_id = u.organization_id
FROM users u
WHERE wt.user_id = u.id
  AND wt.organization_id = '00000000-0000-0000-0000-000000000001';

UPDATE wallet_topup_requests wr
SET organization_id = u.organization_id
FROM users u
WHERE wr.user_id = u.id
  AND wr.organization_id = '00000000-0000-0000-0000-000000000001';

UPDATE oauth_accounts oa
SET organization_id = u.organization_id
FROM users u
WHERE oa.user_id = u.id
  AND oa.organization_id = '00000000-0000-0000-0000-000000000001';

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_email_key;

ALTER TABLE oauth_accounts
  DROP CONSTRAINT IF EXISTS oauth_accounts_provider_provider_uid_key;

CREATE UNIQUE INDEX IF NOT EXISTS users_org_email_uidx
  ON users (organization_id, email);

CREATE UNIQUE INDEX IF NOT EXISTS oauth_accounts_org_provider_uid_uidx
  ON oauth_accounts (organization_id, provider, provider_uid);

CREATE INDEX IF NOT EXISTS contests_org_status_starts_idx
  ON contests (organization_id, status, starts_at);

CREATE INDEX IF NOT EXISTS wallet_transactions_org_user_created_idx
  ON wallet_transactions (organization_id, user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS wallet_topup_requests_org_user_requested_idx
  ON wallet_topup_requests (organization_id, user_id, requested_at DESC);

DROP INDEX IF EXISTS wallet_transactions_unique_prize_reference;

CREATE UNIQUE INDEX IF NOT EXISTS wallet_transactions_org_unique_prize_reference
  ON wallet_transactions (organization_id, user_id, reason, reference_id)
  WHERE reason IN ('prize', 'refund');

DROP INDEX IF EXISTS wallet_topup_requests_one_pending_per_user_idx;

CREATE UNIQUE INDEX IF NOT EXISTS wallet_topup_requests_org_one_pending_per_user_idx
  ON wallet_topup_requests (organization_id, user_id)
  WHERE status = 'pending';
