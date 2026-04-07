CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS organizations_slug_trgm_idx
  ON organizations
  USING gin (slug gin_trgm_ops);

CREATE INDEX IF NOT EXISTS organizations_name_trgm_idx
  ON organizations
  USING gin (name gin_trgm_ops);
