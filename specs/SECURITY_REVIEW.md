# AVOGADRO security review

**Review date:** 2026-10-20
**Scope:** current workspace snapshot; API, worker, Compose, Foundry local runner, data model, and security/architecture specifications.
**Disposition:** not launch-ready for untrusted contract execution or multi-user service. The only execution worker intentionally rejects jobs because no sandboxed runner is wired. This review distinguishes source inspection from controls actually exercised.

## Findings

| Severity | Finding | Evidence and impact | Required closure |
|---|---|---|---|
| Critical for execution | No per-job sandbox or Foundry execution path exists. | `apps/worker/src/index.mjs` validates a campaign ID then throws `Foundry sandbox runner is not configured`. The Compose hardening applies to the worker process only; it does not prove safety of executing compiler/build scripts. | Keep execution disabled until a disposable microVM/VM (or equivalent strong boundary) applies network, filesystem, syscall and resource policy before untrusted processes start. Prove teardown and deny tests. |
| High | Authentication and SIWE are not implemented. | `apps/api/src/app.ts` has an optional injected `authenticate`; default server calls `buildApp()` without one. Campaign endpoints fail closed because there is no store, but SIWE nonce/verify/session routes, cookie handling, CSRF, and production auth wiring are absent. Contract import route returns 503 and is unauthenticated. | Implement SIWE with single-use nonce, signature/domain/URI/chain/time validation, hashed short-lived sessions, secure cookie and CSRF controls; enforce owner scope on every object route. |
| High | Worker queue access is not tenant-scoped or DB-authoritative yet. | Worker accepts `{ campaignId }`, but has no DB client or repository lookup; Redis is unauthenticated and worker shares its network with Redis. No queue producer/outbox path exists in current implementation. A Redis compromise can inject arbitrary IDs/jobs, though current handler fails closed. | Use a dedicated Redis ACL/user and queue namespace; resolve immutable campaign records with narrowly scoped DB credentials; enforce state/idempotency/owner-independent worker authorization and signed/validated immutable inputs. Keep payload identifiers only. |
| High | Local Foundry script does not establish a pinned mainnet fork. | `packages/contracts/scripts/run-local.sh` starts Anvil without `--fork-url`, then invokes `forge test --fork-url` against that local Anvil URL. It does not pin/check a requested block hash, and may simply fork an empty local chain. | Treat this as a local fixture only. Implement the approved control-plane fork preparation with verified chain ID, block number/hash and read-only RPC, then run Forge only against local Anvil. Reject arbitrary user RPC URLs. |
| Medium | Source/build provenance and dependency execution policy are incomplete. | No import provider, source path validation, dependency allowlist, lockfile verification, or build-script/FFI enforcement is present. Worker runner is absent. Worker Dockerfile uses `npm install` from ranges and copies no lockfile; base image uses a version tag rather than digest. | Pin package lock and image digest; verify imported source hashes/provenance; use offline vendored dependencies and reject FFI, shell hooks, arbitrary remappings and networked resolution. |
| Medium | Resource/output limits are only partly represented. | Compose sets worker CPU=1, memory=1 GiB, PID=96 and 256 MiB no-exec `/tmp`; no job wall-clock enforcement, output quota, process-tree kill, or scratch cleanup exists. | Enforce per-job wall-time/output/artifact limits in supervisor and verify process-tree termination and storage destruction under adversarial cases. |
| Medium | API operational hardening is absent. | `apps/api/src/server.ts` listens on `0.0.0.0`; no rate limits, explicit request/body limits, security headers, TLS termination contract, or structured audit trail is wired in the app. Current APIs do not accept executable source and writes are unavailable, limiting immediate exploitability. | Add edge/API request limits, rate limits, production TLS/session policy, audit events, and safe logging before enabling imports or campaigns. |
| Low (local only) | Development credentials and mutable service tags are present. | `docker-compose.yml` has fixed local Postgres/MinIO credentials; Redis has no password; service images use mutable tags. Ports bind loopback. | Keep these explicitly local-only; use secrets and immutable image digests in shared/staging/production environments. |

## Controls observed in source

- Worker container is configured as UID 10001, read-only root, drops all Linux capabilities, enables `no-new-privileges`, limits PIDs/CPU/memory, and provides bounded no-exec `/tmp` (`docker-compose.yml`).
- Worker is attached only to an `internal: true` Docker network. That network also contains Redis, which is separately attached to the backend network. This is useful egress reduction, not proof of a strong hostile-code boundary.
- Worker receives Redis coordinates only, no DB/RPC/object-store/signing credentials or host mount in Compose. Dockerfile runs as non-root.
- Worker rejects payloads with keys other than `campaignId`, then fails closed. It does not execute job-provided commands/source.
- Campaign create/list/get return 503 without a configured store and 401 without injected authentication; GET-by-ID passes owner ID into the store interface. This is fail-closed scaffolding, not verified complete authorization.
- Database schema records owner IDs and immutable-looking digest/snapshot fields, but schema alone does not enforce read authorization or provenance.

## Validation performed

- **Static inspection:** reviewed the named files and searched for container isolation, auth, secret, RPC, and runner controls.
- **Runtime validation:** not performed. `docker` and `forge` are not available in this environment, so Compose policy, network egress denial, limits, Foundry fixture, and process cleanup have not been exercised.
- No claim is made that Docker internal networking, resource caps, SIWE, tenant isolation, or Foundry execution has passed an adversarial test.

## Required pre-launch validation

1. In a disposable environment with Docker, inspect rendered Compose config; verify worker DNS/connectivity to Redis succeeds and external/metadata/private-network routes fail.
2. Attempt host filesystem, Docker socket, namespace, capability, and child-process escape from the worker; verify read-only mounts, no privilege gain, process teardown and scratch deletion.
3. Exercise CPU, memory, PID, wall-time, stdout/stderr, artifact-size and disk exhaustion; verify bounded failure and cleanup.
4. Inject malformed/extra queue fields, stale IDs, duplicate deliveries, wrong state, and another tenant's IDs; require rejection without data disclosure or state change.
5. Add SIWE tests for wrong chain/domain/URI, expired/future timestamps, replayed nonce/signature, cookie theft assumptions, CSRF, and session revocation.
6. Verify a pinned Robinhood Chain block number/hash using the configured read-only RPC, start local Anvil with no public signing/broadcast route, replay a deterministic fixture, and confirm no transaction leaves the sandbox.
7. Scan logs/errors/artifacts for secrets, cross-tenant content, HTML/script active content, path traversal, and oversized payload handling.

## Launch blockers

- Do not enable untrusted source/build execution until the strong per-job isolation boundary and adversarial deny tests exist.
- Do not expose the service to multiple users until SIWE/session security and owner-scoped persistence are implemented and tested.
- Do not describe current Forge execution as a pinned-mainnet campaign; only the isolated worker rejection behavior and fixture files are present in source.
