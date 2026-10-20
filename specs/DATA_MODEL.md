# Database entities and relationships

- `users`: SIWE identity keyed by normalized wallet address; created/updated timestamps.
- `sessions`: hashed opaque session token, user FK, expiry/revocation.
- `contracts`: owner FK, chain ID, address, verified status/source, name/compiler/metadata, unique owner+chain+address.
- `contract_sources`: contract FK, path, content digest, source text, verification provenance.
- `campaigns`: owner FK, contract FK, status, immutable snapshot (number/hash), harness/build digests, seed, fuzz bounds, engine version, timestamps.
- `invariants`: campaign FK, name/description/template or source digest, configuration, enabled flag.
- `campaign_events`: campaign FK, monotonic sequence, event type, safe JSON payload and timestamp for SSE replay.
- `counterexamples`: campaign FK, property/invariant, structured call sequence, trace/log artifact keys and digests, replay manifest.
- `artifacts`: campaign FK, object key, media type, digest, byte count, retention metadata.

Ownership cascades are restricted for evidence-bearing records; deletion is soft/retention controlled. Campaign snapshots and replay inputs are immutable after queueing. Foreign keys and indexes cover owner/status and campaign event sequence.
