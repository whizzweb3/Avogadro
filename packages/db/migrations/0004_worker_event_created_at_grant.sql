-- Drizzle explicitly includes the defaulted created_at value when inserting
-- campaign events. Grant only that additional column to the worker role.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'avogadro_worker') THEN
    EXECUTE 'GRANT INSERT (created_at) ON campaign_events TO avogadro_worker';
  END IF;
END $$;
