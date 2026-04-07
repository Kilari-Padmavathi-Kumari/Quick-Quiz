CREATE UNIQUE INDEX IF NOT EXISTS wallet_transactions_org_unique_entry_fee_reference
  ON wallet_transactions (organization_id, user_id, reason, reference_id)
  WHERE reason = 'entry_fee';
