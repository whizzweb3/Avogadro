# Campaign lifecycle and execution pipeline

## Phase 3 implemented lifecycle

Campaign states are `queued -> running -> completed | failed | cancelled | infrastructure_blocked`. A queued cancellation transaction marks the campaign and pending attempt terminally cancelled. A running cancellation sets `cancelRequestedAt`; the worker polls this flag and terminates the Forge process. Infrastructure retries create new attempt rows and preserve prior attempt results. The campaign's latest status/result is a summary; attempt results and ordered events preserve execution history.

1. The API requires an authenticated SIWE session, CSRF token for mutations, and owner authorization. It validates a strict fixture ID, fixture-matched invariant name, seed, fuzz runs/depth, timeout, and an owner-scoped idempotency key.
2. The API derives fixture/source/execution digests from the repository, then transactionally inserts the immutable campaign config, first attempt, queued event, idempotency record, and outbox row.
3. The worker dispatcher leases outbox rows and publishes only `{ campaignId }` to BullMQ. The worker reloads authoritative configuration from PostgreSQL and leases one attempt. Duplicate delivery with no eligible attempt is acknowledged without executing.
4. The runner accepts only `vault-accounting-v1` and `replay-counterexample-v1`. It copies committed fixture sources into a private temporary directory, checks pinned Forge 1.8.5 and solc 0.8.26, and invokes a fixed offline `forge test` command against a local test EVM. No imported source, public RPC, wallet, signer, broadcast option, or caller-supplied command is supported.
5. The runner enforces configured Forge wall time, bounded output streams, and process-group termination on cancellation/timeout. It parses Forge output conservatively, records digests/versions/seed/limits, and includes a counterexample only when Forge emitted one.
6. The worker persists result, attempt status, and event transactionally; infrastructure failures enter a bounded retry schedule. Scratch cleanup runs in the runner's `finally` path.

## Deliberately unavailable in Phase 3

- Imported contracts and user-authored Solidity/harnesses are not executed.
- Mainnet fork execution and pinned-block verification are disabled; snapshot columns are metadata only.
- SSE, S3 artifact upload/download, signed evidence manifests, and retention cleanup are not wired. Polling the owner-scoped detail endpoint is authoritative; bounded result/evidence content is persisted in PostgreSQL.
- The Compose worker restrictions have not been runtime-tested here. They are defense in depth, not a verified per-job hostile-code sandbox.

Generated transactions remain local test state and cannot be broadcast to Robinhood Chain mainnet.
