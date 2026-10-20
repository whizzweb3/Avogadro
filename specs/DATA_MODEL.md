# Database entities and relationships

- `users`: normalized wallet address from a verified SIWE message.
- `sessions`: hashed opaque session token, CSRF token hash, expiry and revocation timestamps.
- `siwe_nonces`: configured domain/chain, expiry, and one-time consumption timestamp.
- `contracts`: owner-scoped imported contract metadata, chain/address, verification provenance, compiler data, ABI, and runtime bytecode hash.
- `contract_sources`: contract-owned source paths/content digests and verification provenance.
- `campaigns`: owner, optional contract (null for current fixture-only runs), optional replay parent, fixture/version, selected invariant names, source/execution/build digests, seed, runs/depth/timeout, status/outcome/failure fields, bounded latest result, cancel request, and lifecycle timestamps. Robinhood snapshot columns are nullable metadata and unused in Phase 3.
- `campaign_attempts`: one row per worker attempt with attempt number, status, worker ID, lease expiry, terminal time, error code, and immutable per-attempt result. `(campaign_id, attempt_number)` is unique.
- `campaign_events`: ordered per-campaign lifecycle/retry/result events with JSON payloads; sequence is unique per campaign.
- `campaign_idempotency`: owner/operation/key hash, canonical request digest, and campaign ID; owner-operation-key is unique.
- `outbox`: transactional queue handoff records, dispatcher lease, delivery status, and retry metadata. BullMQ only receives the campaign UUID.
- `invariants`, `counterexamples`, and `artifacts`: modeled for richer evidence workflows; Phase 3 currently keeps fixture invariant selection and bounded evidence in the campaign/attempt result JSON. Artifact/object-store APIs are not yet wired.

Evidence-bearing foreign keys use restricted deletion semantics. Owner-scoped API reads/writes filter on owner ID. The worker uses a separate DB role with column-scoped grants; the grants and selected columns match by source inspection, but no real PostgreSQL role/migration execution was possible in the local environment. Campaign snapshots and replay inputs are immutable; replay creates a linked campaign with the exact recorded fixture/config/seed.
