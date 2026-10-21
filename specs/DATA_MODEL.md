# Database entities and relationships

- `users`: normalized wallet address from a verified SIWE message.
- `sessions`: hashed opaque session token, CSRF token hash, expiry and revocation timestamps.
- `siwe_nonces`: configured domain/chain, expiry, and one-time consumption timestamp.
- `contracts`: owner-scoped imported contract metadata, chain/address, verification provenance, compiler data, ABI, and runtime bytecode hash.
- `contract_sources`: contract-owned source paths/content digests and verification provenance.
- `campaigns`: owner, optional contract (null for current fixture-only runs), optional replay parent, fixture/version, selected invariant names and stable runner template IDs, source/execution/build digests, seed, runs/depth/timeout, status/outcome/failure fields, bounded latest result, cancel request, and lifecycle timestamps. Runner-backed template IDs are persisted separately so workers and replay preserve the exact allowlisted identity.
- `campaign_attempts`: one row per worker attempt with attempt number, status, worker ID, lease expiry, terminal time, error code, and immutable per-attempt result. `(campaign_id, attempt_number)` is unique.
- `campaign_events`: ordered per-campaign lifecycle/retry/result events with JSON payloads; sequence is unique per campaign. A database trigger retains the newest 2,000 events per campaign; APIs serve bounded pages.
- `campaign_idempotency`: owner/operation/key hash, canonical request digest, and campaign ID; owner-operation-key is unique.
- `outbox`: transactional queue handoff records, dispatcher lease, delivery status, and retry metadata. BullMQ only receives the campaign UUID.
- `invariants`, `counterexamples`, and `artifacts`: invariants and counterexamples tables remain available for normalized/custom definitions, while the current trusted fixture runner persists selected invariant names and bounded finding metadata in the campaign result JSON. Counterexample text is stored as an integrity-checked artifact; artifact metadata is linked to the campaign. The API projects findings from the immutable run result and links the trace artifact where present.

Campaign history is listed with owner + optional status/fixture filters and bounded offset pagination (`limit` 1–100). Lifecycle events are read with a per-campaign sequence cursor and bounded pages (1–100). Both access paths enforce the campaign owner before returning data. Report evidence digest covers a canonical JSON projection of campaign provenance, recent events, attempts, findings, and artifact metadata; raw stdout and private artifact content are excluded. Counterexample summaries retain bounded parsed call steps and their digest in campaign result metadata; raw trace bytes remain in the artifact store.

Evidence-bearing foreign keys use restricted deletion semantics. Owner-scoped API reads/writes filter on owner ID. The worker uses a separate DB role with column-scoped grants, including read access to the stable template IDs needed to match runner identities. Campaign snapshots and replay inputs are immutable; replay creates a linked campaign with the exact recorded fixture/template/config/seed.
