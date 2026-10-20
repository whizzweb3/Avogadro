# API contracts (v1)

All JSON inputs are Zod validated; errors use `{ error: { code, message, requestId } }` and never echo secrets.

- `GET /health` -> `{ status: "ok", service: "api" }` (liveness only).
- `GET /v1/contracts` -> owned contract summaries; `POST /v1/contracts` accepts `{ chainId: 4663, address }`; import status is explicit.
- `GET /v1/contracts/:id` -> metadata, source files, ABI and provenance.
- `GET /v1/contracts/:id/functions` -> ABI-derived callable function descriptors.
- `POST /v1/campaigns` accepts only a repository fixture ID (`vault-accounting-v1` or `replay-counterexample-v1`), its allowlisted invariant name(s), a 32-byte seed, `runs` (1–10,000), `depth` (1–512), and `timeoutSeconds` (1–300). It requires an `Idempotency-Key`, derives the source/execution digests on the server, persists the campaign and outbox record transactionally, and returns `202 { id, status: "queued" }`.
- `GET /v1/campaigns` lists the authenticated owner's campaigns. `GET /v1/campaigns/:id` returns that owner's immutable configuration, attempt history, status events, result, and bounded evidence content.
- `POST /v1/campaigns/:id/cancel` terminalizes a queued campaign or requests cooperative cancellation from a running worker. A completed result is immutable.
- `POST /v1/campaigns/:id/replay` creates a linked campaign with the original fixture/configuration/seed and no caller overrides.
- Progress is represented by persisted lifecycle events; polling campaign detail is authoritative. SSE is not implemented yet.
- Evidence currently lives in bounded database result JSON. S3-compatible artifact upload, signed evidence manifests, download authorization, and retention cleanup are not implemented.

SIWE `GET /v1/auth/nonce`, `POST /v1/auth/verify`, `GET /v1/auth/session`, and `POST /v1/auth/logout` establish and revoke a server-side session. Configure `SIWE_DOMAIN`, `SIWE_URI`, and `SIWE_CHAIN_ID=4663`. Write endpoints require the session cookie plus the matching `X-CSRF-Token`; all protected reads and mutations are owner-scoped. Queue publication uses transactional outbox semantics. The worker receives only a campaign ID and reloads configuration from PostgreSQL.

Execution is currently restricted to committed fixtures and local Foundry test state. Imported contracts are not fuzzed, mainnet fork execution and pinned-block validation are not enabled, and no transaction broadcast path exists.
