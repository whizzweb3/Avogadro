# API contracts (v1)

All JSON inputs are Zod validated; errors use `{ error: { code, message, requestId } }` and never echo secrets.

- `GET /health` -> `{ status: "ok", service: "api" }` (liveness only).
- `GET /v1/contracts` -> owned contract summaries; `POST /v1/contracts` accepts `{ chainId: 4663, address }`; import status is explicit.
- `GET /v1/contracts/:id` -> metadata, source files, ABI and provenance.
- `GET /v1/contracts/:id/functions` -> ABI-derived callable function descriptors.
- ABI function metadata is inspect-only. The current campaign runner does not execute imported source or generated harnesses.
- `GET /v1/invariants/templates?fixtureId=...` returns only runner-registered templates for trusted fixtures, including category, description, and exact invariant test name. The replay demonstrator is explicitly labeled as an intentional failure, not a security finding.
- `POST /v1/campaigns` accepts only a repository fixture ID (`vault-accounting-v1` or `replay-counterexample-v1`), exactly one of legacy allowlisted `invariants` or runner-backed `templateIds`, a 32-byte seed, `runs` (1–10,000), `depth` (1–512), and `timeoutSeconds` (1–300). The replay fixture template is explicitly labeled as intentional failure scaffolding. It requires an `Idempotency-Key`, derives source/execution digests from the shared runner registry, persists selected names and template IDs with the outbox record transactionally, and returns `202 { id, status: "queued" }`.
- `GET /v1/campaigns` returns `{ items, nextCursor }`; filters include status and fixture, `limit` is bounded to 100, and the numeric cursor is an offset. All results are owner-scoped.
- `GET /v1/campaigns/:id` returns that owner's immutable configuration, attempt history, status events, result, and bounded evidence metadata.
- `GET /v1/campaigns/:id/events?after=...&limit=...` returns ordered persisted lifecycle events after a sequence, capped at 100, plus a next cursor. PostgreSQL retains the latest 2,000 events per campaign.
- `GET /v1/campaigns/:id/findings` returns structured findings only when a trusted run recorded an invariant failure. `GET /v1/campaigns/:id/counterexample` returns verified counterexample text and ordered decoded calls when the matching artifact is available, not expired, and its integrity checks succeed.
- `GET /v1/campaigns/:id/report` produces an owner-scoped JSON evidence report with campaign configuration, provenance, bounded event/attempt summaries, finding data, artifact metadata, and a SHA-256 evidence digest. It does not claim unsupported coverage or synthesize runtime measurements.
- `POST /v1/campaigns/:id/cancel` terminalizes a queued campaign or requests cooperative cancellation from a running worker. A completed result is immutable.
- `POST /v1/campaigns/:id/replay` creates a linked campaign with the original fixture/configuration/seed and no caller overrides.
- Progress is represented by persisted lifecycle events; polling campaign detail is authoritative. SSE is not implemented yet.
- Bounded runner evidence is stored in private S3-compatible object storage; PostgreSQL stores metadata, digests, byte counts, and retention deadlines. Authenticated owner-scoped downloads verify length and SHA-256. The CI environment uses S3Mock and does not prove a production provider's IAM or lifecycle enforcement.

SIWE `GET /v1/auth/nonce`, `POST /v1/auth/verify`, `GET /v1/auth/session`, and `POST /v1/auth/logout` establish and revoke a server-side session. Configure `SIWE_DOMAIN`, `SIWE_URI`, and `SIWE_CHAIN_ID=4663`. Write endpoints require the session cookie plus the matching `X-CSRF-Token`; all protected reads and mutations are owner-scoped. Queue publication uses transactional outbox semantics. The worker receives only a campaign ID and reloads configuration from PostgreSQL.

Execution is currently restricted to committed fixtures and local Foundry test state. Imported contracts are not fuzzed, mainnet fork execution and pinned-block validation are not enabled, and no transaction broadcast path exists. Worker container settings describe configured limits; hostile-workload runtime isolation still requires separate enforcement validation.
