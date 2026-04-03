CREATE UNIQUE INDEX IF NOT EXISTS users_id_org_uidx
  ON users (id, organization_id);

CREATE UNIQUE INDEX IF NOT EXISTS contests_id_org_uidx
  ON contests (id, organization_id);

CREATE INDEX IF NOT EXISTS questions_contest_id_seq_id_idx
  ON questions (contest_id, seq, id);

CREATE INDEX IF NOT EXISTS contest_members_contest_user_idx
  ON contest_members (contest_id, user_id);

CREATE INDEX IF NOT EXISTS answers_contest_question_user_idx
  ON answers (contest_id, question_id, user_id);
