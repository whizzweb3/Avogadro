# Phase 3 campaign execution contract

## Scope and trust boundary

The first engine may execute only repository-owned fixture IDs: `vault-accounting-v1` and `replay-counterexample-v1`. The API never accepts Solidity, shell commands, Forge arguments, working directories, RPC URLs, or environment variables from a caller. It resolves a fixture ID to a committed source tree and a fixed command. Do not run imported contract sources. Enable user-supplied harnesses only after the security review's isolation deny-tests pass.

All Forge runs use local test EVM state. No `--broadcast`, deploy script, public RPC, signer, credential, or wallet material is passed to the runner. A pinned chain snapshot is campaign metadata only in this phase; fork execution remains disabled until a reviewed, read-only RPC boundary and reproducible Anvil fork are implemented.

## Campaign input and deterministic execution

`POST /v1/campaigns` accepts a fixture ID, invariant selection, bounded `runs`, invariant `depth`, 32-byte seed, and a timeout no greater than 300 seconds. The server resolves the fixture and derives its source/build digests; client-provided digests are not trusted. Fixed Foundry/solc versions and fixture version are recorded with every attempt. Input validation happens before persistence or enqueue.

The execution identity is the digest of canonical JSON containing fixture ID/version, selected invariants, runs, depth, seed, Forge version, solc version, and runner version. Identical inputs may be submitted idempotently using owner-scoped `Idempotency-Key`; retries create a new attempt while retaining prior result evidence.

## States and result semantics

State transitions are `created -> queued -> running -> completed | failed | cancelled | infrastructure_blocked`. Terminal states do not transition. `cancelRequestedAt` is separate from final status. A deliberate invariant violation is `status=failed`, `failureKind=invariant_violation`, and `outcome=failed`; missing tools, unavailable isolation, process startup errors, or corrupt output are `status=infrastructure_blocked` with a specific infrastructure code. Timeout is `status=failed`, `failureKind=timeout`. Worker crash/retry is attempt-level and must not erase prior attempts.

Only parsed Forge output may determine test outcome. The result contract records fixture ID, execution digest, status, `outcome` (`passed`, `failed`, or null), failure kind/code, Forge/solc/runner versions, seed, effective limits, timestamps, attempt number, exit code, bounded stdout/stderr, and artifact manifests with SHA-256 and byte counts. Counterexample content is included only when Forge emits it; otherwise it is absent, never synthesized.

## API interface for implementation

- `POST /v1/campaigns` with `Idempotency-Key` returns `202 { id, status: "queued" }` only after durable persistence and successful queue handoff/outbox acceptance. Reusing the key with different canonical input returns `409`.
- `GET /v1/campaigns` lists the caller's campaigns; `GET /v1/campaigns/:id` returns caller-owned immutable config, current status, attempts, and result.
- `POST /v1/campaigns/:id/cancel` marks a cooperative cancel request and returns current status; it cannot rewrite a completed result.
- `POST /v1/campaigns/:id/replay` uses the exact recorded fixture/config/seed and creates a linked attempt or replay campaign; no client override is accepted.
- Events/progress are based on persisted status/output, not synthetic percentage. If streaming is unavailable, polling remains authoritative.

All reads and writes are owner-scoped, including by-ID, replay and cancel. Requests without an authenticated SIWE session fail closed.

## Worker and execution contract

BullMQ payload contains only `{ campaignId }`. The worker reloads authoritative campaign data from PostgreSQL, leases one attempt atomically, enforces concurrency one, and acknowledges only after result persistence. Infrastructure errors use bounded retries with backoff; invariant failures and cancellation are not retried automatically. Duplicate delivery is idempotent by attempt/job ID. Worker shutdown stops claiming, forwards cancellation, terminates the child process tree, persists an interruption if possible, and removes its per-job scratch directory.

The runner passes a minimal explicit environment, fixed arguments and an absolute known fixture path, starts a new process group, captures bounded stdout/stderr, enforces a wall timeout, kills the process group on cancellation/timeout, hashes artifacts, and never accepts arbitrary paths or flags. It must fail closed if Foundry/solc versions or required isolation configuration do not match. Host resource limits are not considered an OS sandbox; imported source remains ineligible until a verified disposable sandbox is available.

## Persistence additions

Persist the immutable campaign config and input digest, owner-scoped idempotency record, attempts, status events, result JSON, counterexample manifest, and bounded output artifact metadata. Use check constraints for configuration bounds and unique constraints for `(owner, operation, key hash)` and `(campaign, attempt number)`. Campaign status/result updates and event writes are transactional. Queue delivery uses an outbox or a durable equivalent and reconciliation handles process crashes between DB and Redis.

## Verification

Tests use the real trusted passing and expected-failure Forge fixtures. They assert exit status parsing, invariant failure vs infrastructure failure, deterministic seed/config identity, output truncation, timeout and process-tree termination, cancellation, worker retry/duplicate delivery, idempotency conflict, owner scoping, and database transaction behavior. Redis tests use real Redis. PostgreSQL migration tests use real PostgreSQL. A runtime isolation claim requires tests executed under the intended isolation boundary; Compose policy inspection alone is insufficient.
