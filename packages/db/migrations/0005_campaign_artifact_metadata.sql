-- Name is required to expose stable, owner-scoped artifact links without
-- returning object-store keys from campaign result JSON.
ALTER TABLE artifacts ADD COLUMN name text NOT NULL DEFAULT 'artifact';
ALTER TABLE artifacts ALTER COLUMN name DROP DEFAULT;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'avogadro_worker') THEN
    EXECUTE 'GRANT INSERT (campaign_id, name, object_key, media_type, digest, byte_count, retain_until, created_at) ON artifacts TO avogadro_worker';
  END IF;
END $$;
