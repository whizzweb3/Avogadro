# AVOGADRO security review

**Review date:** 2026-10-21
**Scope:** Phase 2 API, ingestion package, DB contract store, worker, Compose, Foundry runner, and security specifications.
**Disposition:** Not launch-ready for untrusted contract execution or multi-user service. Phase 2 adds a bounded fixed-provider ingestion path, owner-scoped storage interfaces, and import idempotency. Live authentication wiring and sandboxed Foundry execution remain absent. Findings distinguish source inspection from executed validation.

## Findings

| Severity | Finding | Evidence and impact | Required closure |
|---|---|---|---|
| Critical for execution | No per-job sandbox or Foundry execution path exists. | `apps/worker/src/index.mjs` validates a campaign ID then throws `Foundry sandbox runner is not configured`. Compose hardening applies to the worker process; it does not prove safety of hostile compiler/build scripts. | Keep execution disabled until a disposable microVM/VM or equivalent strong boundary applies network, filesystem, syscall and resource policy before untrusted processes start. Prove teardown and deny tests. |
| High | Authentication and SIWE remain unimplemented; production wiring has no identity provider. | `apps/api/src/app.ts` protects contract list/import/get and campaign operations through optional injected `authenticate`, but `apps/api/src/server.ts` calls `buildApp()` without it. Current contract routes return 401; campaign routes remain unavailable. SIWE nonce/verify/session routes, cookie handling, and CSRF are absent. | Implement SIWE with single-use nonce, signature/domain/URI/chain/time validation, hashed short-lived sessions, secure cookie and CSRF controls; wire it in the server and test owner scoping on every object route. |
| High | Worker queue access is not DB-authoritative or tenant scoped. | Worker accepts `{ campaignId }` but has no DB client/repository lookup; Redis has no auth and is shared with the worker's internal network. There is no producer/outbox path. Redis compromise could inject jobs, although the handler currently fails closed. | Use a dedicated Redis ACL/user and queue namespace; resolve immutable campaign records with narrowly scoped credentials; enforce state/idempotency and validate immutable inputs. Keep queue payload identifiers only. |
| High | Ingestion does not independently bind verified source/build metadata to fetched on-chain runtime bytecode. | `packages/ingestion/src/index.ts` checks Blockscout verification flags and fetches `eth_getCode` plus `web3_sha3`, but does not compile the submitted standard JSON input and compare deployed bytecode. `is_changed_bytecode` comes from the same explorer response. Imported source is therefore not independently proven to match runtime code. | Label provenance accurately; independently recompile with pinned compiler/settings and compare normalized runtime bytecode (document immutable/library linking), or use an authoritative verification endpoint with a tested guarantee. |
| Medium | Ingestion RPC redirects are not explicitly disabled. | Explorer fetch uses `redirect: "error"`; `rpcCall` validates a fixed official HTTPS hostname but calls fetch without a redirect policy, whose default follows redirects. A compromised endpoint/DNS path could redirect requests elsewhere. | Set `redirect: "error"` on RPC fetch too; retain egress allowlisting and test redirect responses are rejected. |
| Medium | Source/build execution policy and worker supply-chain controls remain incomplete. | Ingestion now has fixed-provider source retrieval, path checks, per-file count/size limits, hashes, response byte limit and timeouts. There is still no dependency allowlist, build-input lock verification, or FFI/shell-hook enforcement. Worker runner is absent. Worker Dockerfile uses `npm install`, no lockfile, and a tagged base image rather than digest. | Pin worker dependencies and image digest; use offline vendored dependencies and reject FFI, shell hooks, arbitrary remappings and networked resolution before build execution. |
| Medium | Resource/output limits are only partly represented. | Compose sets worker CPU=1, memory=1 GiB, PID=96 and 256 MiB no-exec `/tmp`; there is no job wall-clock enforcement, output quota, process-tree kill, or scratch cleanup. | Enforce per-job wall-time/output/artifact limits in a supervisor and verify termination and scratch destruction under adversarial cases. |
| Medium | API operational hardening is absent. | `apps/api/src/server.ts` listens on `0.0.0.0`; no rate limits, explicit request/body limits, security headers, TLS termination contract, or structured audit trail is wired in. | Add edge/API request limits, rate limits, production TLS/session policy, audit events, and safe logging before enabling imports or campaigns. |
| Low (local only) | Development credentials and mutable service tags are present. | `docker-compose.yml` has fixed local Postgres/MinIO credentials; Redis has no password; image tags are mutable. Ports bind loopback. | Keep values local-only; use secrets and immutable image digests outside local development. |

## Controls observed in source

- Worker container is UID 10001, read-only root, drops Linux capabilities, enables `no-new-privileges`, limits PIDs/CPU/memory, and provides bounded no-exec `/tmp` (`docker-compose.yml`).
- Worker is attached only to `internal: true` Docker network. Redis also joins that network and the backend network. This reduces egress but is not a strong hostile-code boundary.
- Worker receives only Redis coordinates in Compose, no DB/RPC/object-store/signing credentials or host mount. It rejects job data with fields beyond `campaignId`, then fails closed.
- Contract list/import/get and campaign routes require an injected owner identity; default server does not inject one, so operations are denied.
- Ingestion uses fixed Blockscout and Robinhood RPC hosts; explorer redirects are denied; responses are capped at 8 MiB; requests time out after 10 seconds; source paths/count/per-file sizes are constrained; source SHA-256 digests are computed; proxy depth/cycles are checked.
- Contract store queries include `ownerId`; idempotency keys are hashed and scoped by owner and operation, with request digest conflict detection. These are source observations, not database concurrency or tenant isolation validation.

## Validation performed

- Static inspection of ingestion, API, store, worker, Compose, and runner sources.
- Root automated checks passed: typecheck, lint, five API/schema tests, web production build, and `drizzle-kit check`. The ingestion package reported four deterministic tests passing when run through the root `tsx` test command.
- Forge 1.8.5 and solc 0.8.26 were run locally. The passing invariant executed 64 runs and 2,048 handler calls; the separate expected-failure fixture reproduced its deliberate assertion failure. This verifies the local fixture only, not imported or mainnet contracts.
- Redis 7.4.2 was built from checksum-verified source and exercised with the BullMQ worker. A queued campaign was consumed and failed closed because the sandbox runner is intentionally unconfigured.
- Docker daemon access was denied. A checksum-verified PostgreSQL 17.6 source build completed, but cluster initialization was denied by the environment's SysV shared-memory restriction. An existing local PostgreSQL socket rejected the available identity. No real migration execution or Compose validation was completed.
- The API server returned HTTP 200 from `/health` when started with a configured database URL; this is a liveness check and does not prove database connectivity.
- No claim is made that SIWE, tenant isolation, source-to-bytecode matching, container isolation, or Foundry execution passed an adversarial test.

## Required pre-launch validation

1. With Docker, inspect rendered Compose config; verify worker-to-Redis access and denial of external, metadata and private-network routes.
2. Attempt host filesystem, Docker socket, namespace, capability and child-process escape; verify read-only mounts, no privilege gain, process teardown and scratch deletion.
3. Exercise CPU, memory, PID, wall-time, stdout/stderr, artifact-size and disk exhaustion; verify bounded failure and cleanup.
4. Inject malformed/extra queue fields, stale IDs, duplicate deliveries, wrong state and another tenant's IDs; require rejection without data disclosure or state change.
5. Add SIWE tests for wrong chain/domain/URI, expired/future timestamps, nonce replay, CSRF, and session revocation.
6. Verify a pinned Robinhood block number/hash using configured read-only RPC, execute only against local Anvil, replay a deterministic fixture, and confirm no transaction leaves the sandbox.
7. Verify source-to-runtime-bytecode equivalence for supported compiler/linking cases; test redirect rejection, oversized/slow responses, path traversal, and malformed explorer payloads.
8. Scan logs/errors/artifacts for secrets, cross-tenant content, active HTML/script content, and oversized payload handling.

## Launch blockers

- Do not enable untrusted source/build execution until a strong per-job isolation boundary and adversarial deny tests exist.
- Do not expose the service to multiple users until SIWE/session security is implemented, production auth is wired, and owner-scoped persistence is tested.
- Do not describe current imports as independently source-to-bytecode verified or current Forge files as a pinned-mainnet campaign.

## Phase 2 review notes

- Improvement: import is no longer a stub. Caller-controlled RPC URLs are not accepted by the API; contract routes require injected identity; imported contract storage is owner scoped; idempotency collisions are checked against request digest.
- Remaining concern: explorer verification remains an assertion from the explorer response, not an independent source/build-to-runtime proof. Label provenance accordingly until source equivalence is checked.
- Ingestion test invocation is environment-sensitive: the standalone workspace command can fail before assertions when tsx cannot create an IPC pipe (`listen EPERM`); running the package tests through the root `tsx` test command passed all four deterministic cases.
