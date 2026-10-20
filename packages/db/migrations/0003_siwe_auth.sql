CREATE TABLE siwe_nonces (
  nonce varchar(64) PRIMARY KEY,
  domain text NOT NULL,
  chain_id integer NOT NULL CHECK (chain_id = 4663),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX siwe_nonces_expiry_idx ON siwe_nonces(expires_at);
ALTER TABLE sessions ADD COLUMN csrf_hash varchar(64);
