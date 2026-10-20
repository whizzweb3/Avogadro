ALTER TYPE campaign_status ADD VALUE IF NOT EXISTS 'completed';
ALTER TYPE campaign_status ADD VALUE IF NOT EXISTS 'infrastructure_blocked';
ALTER TABLE campaigns ALTER COLUMN contract_id DROP NOT NULL;
ALTER TABLE campaigns ADD COLUMN fixture_id varchar(80);
ALTER TABLE campaigns ADD COLUMN fixture_version varchar(40);
ALTER TABLE campaigns ADD COLUMN execution_digest varchar(64);
ALTER TABLE campaigns ADD COLUMN selected_invariants jsonb;
ALTER TABLE campaigns ADD COLUMN outcome varchar(16);
ALTER TABLE campaigns ADD COLUMN failure_kind varchar(40);
ALTER TABLE campaigns ADD COLUMN failure_code varchar(80);
ALTER TABLE campaigns ADD COLUMN result jsonb;
ALTER TABLE campaigns ADD COLUMN parent_campaign_id uuid REFERENCES campaigns(id) ON DELETE RESTRICT;
ALTER TABLE campaigns ADD CONSTRAINT campaigns_fixture_allowlist_check CHECK (fixture_id IN ('vault-accounting-v1', 'replay-counterexample-v1'));
ALTER TABLE campaigns ADD CONSTRAINT campaigns_fixture_bounds_check CHECK (runs <= 10000 AND depth <= 512 AND timeout_seconds BETWEEN 1 AND 300);
CREATE TABLE campaign_idempotency (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  operation varchar(80) NOT NULL,
  key_hash varchar(64) NOT NULL,
  request_digest varchar(64) NOT NULL,
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX campaign_idempotency_owner_operation_key_uq ON campaign_idempotency(owner_id, operation, key_hash);
ALTER TABLE campaign_attempts ADD COLUMN result jsonb;
ALTER TABLE campaign_attempts ADD COLUMN lease_expires_at timestamptz;
ALTER TABLE outbox ADD COLUMN locked_until timestamptz;
ALTER TABLE outbox ADD COLUMN dispatcher_id text;
ALTER TABLE campaigns ALTER COLUMN build_digest DROP NOT NULL;
ALTER TABLE campaigns ALTER COLUMN snapshot_block_number DROP NOT NULL;
ALTER TABLE campaigns ALTER COLUMN snapshot_block_hash DROP NOT NULL;
ALTER TABLE campaigns ALTER COLUMN harness_digest DROP NOT NULL;
ALTER TABLE campaigns ADD COLUMN source_digest varchar(64);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'avogadro_worker') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA public TO avogadro_worker';
    EXECUTE 'GRANT SELECT (id, fixture_id, fixture_version, execution_digest, selected_invariants, status, source_digest, build_digest, cancel_requested_at, runs, depth, seed, timeout_seconds) ON campaigns TO avogadro_worker';
    EXECUTE 'GRANT REFERENCES (id) ON campaigns TO avogadro_worker';
    EXECUTE 'GRANT UPDATE (status, started_at, outcome, failure_kind, failure_code, source_digest, build_digest, result, finished_at) ON campaigns TO avogadro_worker';
    EXECUTE 'GRANT SELECT (id, campaign_id, attempt_number, status, worker_id, finished_at, lease_expires_at) ON campaign_attempts TO avogadro_worker';
    EXECUTE 'GRANT INSERT (campaign_id, attempt_number, status) ON campaign_attempts TO avogadro_worker';
    EXECUTE 'GRANT UPDATE (status, worker_id, started_at, finished_at, lease_expires_at, error_code, result) ON campaign_attempts TO avogadro_worker';
    EXECUTE 'GRANT SELECT (campaign_id, sequence) ON campaign_events TO avogadro_worker';
    EXECUTE 'GRANT INSERT (campaign_id, sequence, event_type, payload) ON campaign_events TO avogadro_worker';
    EXECUTE 'GRANT SELECT (id, topic, aggregate_id, payload, status, attempts, available_at, locked_until, dispatcher_id, delivered_at, created_at) ON outbox TO avogadro_worker';
    EXECUTE 'GRANT INSERT (topic, aggregate_id, payload, available_at) ON outbox TO avogadro_worker';
    EXECUTE 'GRANT UPDATE (attempts, dispatcher_id, locked_until, status, delivered_at) ON outbox TO avogadro_worker';
  END IF;
END $$;
