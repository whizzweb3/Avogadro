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
     OR NOT has_column_privilege('avogadro_worker', 'campaigns', 'fixture_id', 'SELECT')
     OR NOT has_column_privilege('avogadro_worker', 'campaigns', 'template_ids', 'SELECT') THEN
    RAISE EXCEPTION 'campaign read grants are missing or broader than expected';
  END IF;
  IF has_column_privilege('avogadro_worker', 'campaigns', 'owner_id', 'UPDATE')
     OR NOT has_column_privilege('avogadro_worker', 'campaigns', 'status', 'UPDATE') THEN
    RAISE EXCEPTION 'campaign update grants are missing or broader than expected';
  END IF;
  IF NOT has_column_privilege('avogadro_worker', 'campaign_attempts', 'lease_expires_at', 'UPDATE')
     OR NOT has_column_privilege('avogadro_worker', 'campaign_attempts', 'id', 'INSERT')
     OR has_table_privilege('avogadro_worker', 'campaign_attempts', 'INSERT')
     OR has_column_privilege('avogadro_worker', 'campaign_attempts', 'campaign_id', 'UPDATE') THEN
    RAISE EXCEPTION 'attempt lease grants are missing or broader than expected';
  END IF;
  IF NOT has_column_privilege('avogadro_worker', 'outbox', 'locked_until', 'UPDATE')
     OR NOT has_column_privilege('avogadro_worker', 'outbox', 'id', 'INSERT')
     OR has_table_privilege('avogadro_worker', 'outbox', 'INSERT')
     OR has_column_privilege('avogadro_worker', 'outbox', 'payload', 'UPDATE') THEN
    RAISE EXCEPTION 'outbox grants are missing or broader than expected';
  END IF;
  IF NOT has_column_privilege('avogadro_worker', 'campaign_events', 'created_at', 'INSERT')
     OR has_table_privilege('avogadro_worker', 'campaign_events', 'INSERT')
     OR has_column_privilege('avogadro_worker', 'campaign_events', 'campaign_id', 'UPDATE') THEN
    RAISE EXCEPTION 'campaign event timestamp insert grant is missing or broader than expected';
  END IF;
  IF NOT has_column_privilege('avogadro_worker', 'artifacts', 'campaign_id', 'INSERT')
     OR NOT has_column_privilege('avogadro_worker', 'artifacts', 'id', 'INSERT')
     OR NOT has_column_privilege('avogadro_worker', 'artifacts', 'object_key', 'INSERT')
     OR NOT has_column_privilege('avogadro_worker', 'artifacts', 'name', 'INSERT')
     OR NOT has_column_privilege('avogadro_worker', 'artifacts', 'media_type', 'INSERT')
     OR NOT has_column_privilege('avogadro_worker', 'artifacts', 'digest', 'INSERT')
     OR NOT has_column_privilege('avogadro_worker', 'artifacts', 'byte_count', 'INSERT')
     OR NOT has_column_privilege('avogadro_worker', 'artifacts', 'retain_until', 'INSERT')
     OR NOT has_column_privilege('avogadro_worker', 'artifacts', 'created_at', 'INSERT')
     OR has_table_privilege('avogadro_worker', 'artifacts', 'SELECT')
     OR has_table_privilege('avogadro_worker', 'artifacts', 'DELETE')
     OR has_column_privilege('avogadro_worker', 'artifacts', 'campaign_id', 'UPDATE') THEN
    RAISE EXCEPTION 'artifact metadata grants are missing or broader than expected';
  END IF;
END
$$;

-- Prove the migration actually retains a bounded event window. This entire
-- fixture is rolled back and does not leave a synthetic campaign behind.
BEGIN;
DO $$
DECLARE
  test_owner uuid;
  test_campaign uuid;
  event_count bigint;
  first_sequence bigint;
  sequence_value integer;
BEGIN
  INSERT INTO users(wallet_address)
  VALUES ('0x' || substr(md5(random()::text), 1, 40))
  RETURNING id INTO test_owner;
  INSERT INTO campaigns(owner_id, fixture_id, fixture_version, selected_invariants, seed, runs, depth, timeout_seconds)
  VALUES (test_owner, 'vault-accounting-v1', 'test', '[]'::jsonb, '0x' || repeat('0', 64), 1, 1, 1)
  RETURNING id INTO test_campaign;
  FOR sequence_value IN 1..2001 LOOP
    INSERT INTO campaign_events(campaign_id, sequence, event_type, payload)
    VALUES (test_campaign, sequence_value, 'retention_check', '{}'::jsonb);
  END LOOP;
  SELECT count(*), min(sequence) INTO event_count, first_sequence
  FROM campaign_events WHERE campaign_id = test_campaign;
  IF event_count <> 2000 OR first_sequence <> 2 THEN
    RAISE EXCEPTION 'campaign event retention did not preserve exactly the latest 2000 rows: count %, first %', event_count, first_sequence;
  END IF;
END
$$;
ROLLBACK;
