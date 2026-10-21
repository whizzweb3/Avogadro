ALTER TABLE campaigns
  ADD COLUMN template_ids jsonb NOT NULL DEFAULT '[]'::jsonb;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'avogadro_worker') THEN
    EXECUTE 'GRANT SELECT (template_ids) ON campaigns TO avogadro_worker';
  END IF;
END $$;

-- Existing campaigns predate stable template IDs. Preserve their historic
-- runner input as an empty template list; replay remains bound to stored
-- invariant names for those rows.
