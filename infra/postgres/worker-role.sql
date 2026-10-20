-- Local Compose only. Production credentials and grants must be managed separately.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'avogadro_worker') THEN
    CREATE ROLE avogadro_worker LOGIN PASSWORD 'avogadro-worker-local-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$$;
GRANT CONNECT ON DATABASE avogadro TO avogadro_worker;
