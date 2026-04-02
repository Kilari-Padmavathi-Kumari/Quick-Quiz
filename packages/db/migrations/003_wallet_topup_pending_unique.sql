CREATE UNIQUE INDEX IF NOT EXISTS wallet_topup_requests_one_pending_per_user_idx
  ON wallet_topup_requests (user_id)
  WHERE status = 'pending';
