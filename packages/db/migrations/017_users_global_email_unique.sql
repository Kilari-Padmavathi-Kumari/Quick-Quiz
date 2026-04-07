DROP INDEX IF EXISTS users_org_email_uidx;

CREATE UNIQUE INDEX IF NOT EXISTS users_email_uidx
  ON users (LOWER(email));
