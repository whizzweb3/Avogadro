# API contracts (v1)

All JSON inputs are Zod validated; errors use `{ error: { code, message, requestId } }` and never echo secrets.

- `GET /health` -> `{ status: "ok", service: "api" }` (liveness only).
- `GET /v1/contracts` -> owned contract summaries; `POST /v1/contracts` accepts `{ chainId: 4663, address }`; import status is explicit.
- `GET /v1/contracts/:id` -> metadata, source files, ABI and provenance.
- `GET /v1/contracts/:id/functions` -> ABI-derived callable function descriptors.
- `POST /v1/campaigns` accepts contract ID, pinned `{ blockNumber, blockHash }`, harness/build digests, seed, fuzz runs/depth/time bounds and invariant definitions. Snapshot hash is checked against configured read-only RPC before queueing.
- `GET /v1/campaigns` and `GET /v1/campaigns/:id` -> authorized status/config/results.
- `POST /v1/campaigns/:id/cancel` -> cooperative cancellation when safe.
- `GET /v1/campaigns/:id/events` -> SSE; supports `Last-Event-ID`, heartbeat, ownership checks and bounded replay.
- `POST /v1/campaigns/:id/replay` -> requeue exact immutable inputs/seed.
- `GET /v1/campaigns/:id/evidence` -> signed/authorized evidence manifest and artifact references.

SIWE nonce/verify routes establish a short-lived session; write endpoints require CSRF protection and owner authorization. Queue publication uses transactional outbox semantics.
