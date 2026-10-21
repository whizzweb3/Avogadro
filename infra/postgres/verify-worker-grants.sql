-- Assert that migrations grant only the worker's required table/column access.
DO $$
DECLARE
  worker_role pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO worker_role FROM pg_roles WHERE rolname = 'avogadro_worker';
  IF NOT FOUND THEN RAISE EXCEPTION 'avogadro_worker role is missing'; END IF;
  IF worker_role.rolsuper OR worker_role.rolcreatedb OR worker_role.rolcreaterole OR worker_role.rolinherit THEN
    RAISE EXCEPTION 'avogadro_worker has an unsafe role attribute';
  END IF;

  IF has_table_privilege('avogadro_worker', 'campaigns', 'SELECT')
     OR has_column_privilege('avogadro_worker', 'campaigns', 'owner_id', 'SELECT')
     OR NOT has_column_privilege('avogadro_worker', 'campaigns', 'fixture_id', 'SELECT') THEN
    RAISE EXCEPTION 'campaign read grants are missing or broader than expected';
  END IF;
  IF has_column_privilege('avogadro_worker', 'campaigns', 'owner_id', 'UPDATE')
     OR NOT has_column_privilege('avogadro_worker', 'campaigns', 'status', 'UPDATE') THEN
    RAISE EXCEPTION 'campaign update grants are missing or broader than expected';
  END IF;
  IF NOT has_column_privilege('avogadro_worker', 'campaign_attempts', 'lease_expires_at', 'UPDATE')
     OR has_column_privilege('avogadro_worker', 'campaign_attempts', 'campaign_id', 'UPDATE') THEN
    RAISE EXCEPTION 'attempt lease grants are missing or broader than expected';
  END IF;
  IF NOT has_column_privilege('avogadro_worker', 'outbox', 'locked_until', 'UPDATE')
     OR has_column_privilege('avogadro_worker', 'outbox', 'payload', 'UPDATE') THEN
    RAISE EXCEPTION 'outbox grants are missing or broader than expected';
  END IF;
  IF NOT has_column_privilege('avogadro_worker', 'campaign_events', 'created_at', 'INSERT')
     OR has_table_privilege('avogadro_worker', 'campaign_events', 'INSERT')
     OR has_column_privilege('avogadro_worker', 'campaign_events', 'campaign_id', 'UPDATE') THEN
    RAISE EXCEPTION 'campaign event timestamp insert grant is missing or broader than expected';
  END IF;
END
$$;
