ALTER TABLE contests
  ADD COLUMN IF NOT EXISTS lifecycle_status TEXT;

UPDATE contests
SET lifecycle_status = CASE status
  WHEN 'live' THEN 'STARTED'
  WHEN 'ended' THEN 'COMPLETED'
  WHEN 'cancelled' THEN 'CANCELLED'
  ELSE 'PENDING'
END
WHERE lifecycle_status IS NULL;

ALTER TABLE contests
  ALTER COLUMN lifecycle_status SET NOT NULL;

ALTER TABLE contests
  ALTER COLUMN lifecycle_status SET DEFAULT 'PENDING';

ALTER TABLE contests
  DROP CONSTRAINT IF EXISTS contests_lifecycle_status_check;

ALTER TABLE contests
  ADD CONSTRAINT contests_lifecycle_status_check
  CHECK (lifecycle_status IN ('PENDING', 'STARTED', 'COMPLETED', 'CANCELLED'));

ALTER TABLE wallet_transactions
  ADD COLUMN IF NOT EXISTS tx_status TEXT;

UPDATE wallet_transactions
SET tx_status = 'SUCCESS'
WHERE tx_status IS NULL;

UPDATE wallet_transactions wt
SET tx_status = 'REFUNDED'
FROM wallet_transactions refunds
WHERE wt.tx_status = 'SUCCESS'
  AND wt.reason = 'entry_fee'
  AND refunds.organization_id = wt.organization_id
  AND refunds.user_id = wt.user_id
  AND refunds.reason = 'refund'
  AND refunds.reference_id = wt.reference_id;

ALTER TABLE wallet_transactions
  ALTER COLUMN tx_status SET NOT NULL;

ALTER TABLE wallet_transactions
  ALTER COLUMN tx_status SET DEFAULT 'SUCCESS';

ALTER TABLE wallet_transactions
  DROP CONSTRAINT IF EXISTS wallet_transactions_tx_status_check;

ALTER TABLE wallet_transactions
  ADD CONSTRAINT wallet_transactions_tx_status_check
  CHECK (tx_status IN ('PENDING', 'SUCCESS', 'FAILED', 'REFUNDED'));

CREATE INDEX IF NOT EXISTS contests_lifecycle_status_idx
  ON contests (organization_id, lifecycle_status, starts_at);

CREATE INDEX IF NOT EXISTS wallet_transactions_tx_status_idx
  ON wallet_transactions (organization_id, user_id, tx_status, created_at DESC);
