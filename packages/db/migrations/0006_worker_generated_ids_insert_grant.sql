-- Drizzle includes generated primary-key columns in INSERT statements even
-- when their values are DEFAULT. Grant only those generated IDs needed for
-- worker-created retry/artifact rows; no table-level INSERT is added.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'avogadro_worker') THEN
    EXECUTE 'GRANT INSERT (id) ON campaign_attempts TO avogadro_worker';
    EXECUTE 'GRANT INSERT (id) ON outbox TO avogadro_worker';
    EXECUTE 'GRANT INSERT (id) ON artifacts TO avogadro_worker';
  END IF;
END $$;
