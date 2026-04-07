CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email CITEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  avatar_url TEXT,
  wallet_balance NUMERIC(12, 2) NOT NULL DEFAULT 0,
  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  is_banned BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (wallet_balance >= 0)
);

CREATE TABLE IF NOT EXISTS oauth_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_uid TEXT NOT NULL,
  email CITEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, provider_uid)
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS contests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  entry_fee NUMERIC(12, 2) NOT NULL,
  max_members INTEGER NOT NULL,
  member_count INTEGER NOT NULL DEFAULT 0,
  starts_at TIMESTAMPTZ NOT NULL,
  current_q INTEGER NOT NULL DEFAULT 0,
  q_started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  prize_rule TEXT NOT NULL DEFAULT 'all_correct',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (status IN ('draft', 'open', 'live', 'ended', 'cancelled')),
  CHECK (entry_fee > 0),
  CHECK (max_members > 0 AND max_members <= 100),
  CHECK (member_count >= 0 AND member_count <= max_members),
  CHECK (prize_rule IN ('all_correct', 'top_scorer'))
);

CREATE TABLE IF NOT EXISTS questions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contest_id UUID NOT NULL REFERENCES contests(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  body TEXT NOT NULL,
  option_a TEXT NOT NULL,
  option_b TEXT NOT NULL,
  option_c TEXT NOT NULL,
  option_d TEXT NOT NULL,
  correct_option TEXT NOT NULL,
  time_limit_sec INTEGER NOT NULL,
  revealed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (contest_id, seq),
  CHECK (correct_option IN ('a', 'b', 'c', 'd')),
  CHECK (time_limit_sec > 0)
);

CREATE TABLE IF NOT EXISTS contest_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contest_id UUID NOT NULL REFERENCES contests(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_winner BOOLEAN NOT NULL DEFAULT FALSE,
  prize_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
  UNIQUE (contest_id, user_id)
);

CREATE TABLE IF NOT EXISTS answers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contest_id UUID NOT NULL REFERENCES contests(id) ON DELETE CASCADE,
  question_id UUID NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chosen_option TEXT NOT NULL,
  is_correct BOOLEAN NOT NULL,
  answered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (question_id, user_id),
  CHECK (chosen_option IN ('a', 'b', 'c', 'd'))
);

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  reason TEXT NOT NULL,
  amount NUMERIC(12, 2) NOT NULL,
  balance_before NUMERIC(12, 2) NOT NULL,
  balance_after NUMERIC(12, 2) NOT NULL,
  reference_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (type IN ('credit', 'debit')),
  CHECK (reason IN ('entry_fee', 'prize', 'refund', 'topup', 'manual_topup')),
  CHECK (amount > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS wallet_transactions_unique_prize_reference
  ON wallet_transactions (user_id, reason, reference_id)
  WHERE reason IN ('prize', 'refund');

CREATE INDEX IF NOT EXISTS contests_open_idx
  ON contests (status, starts_at);

CREATE INDEX IF NOT EXISTS questions_contest_seq_idx
  ON questions (contest_id, seq);

CREATE INDEX IF NOT EXISTS contest_members_contest_idx
  ON contest_members (contest_id, joined_at);

CREATE INDEX IF NOT EXISTS answers_contest_user_idx
  ON answers (contest_id, user_id);

CREATE INDEX IF NOT EXISTS refresh_tokens_user_idx
  ON refresh_tokens (user_id, expires_at);
