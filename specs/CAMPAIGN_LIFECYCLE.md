# Campaign lifecycle and execution pipeline

`draft -> queued -> preparing -> running -> (passed | failed | cancelled | timed_out | error)`; terminal states are immutable. Retries use attempt records and do not rewrite prior evidence. A cancellation request is separate from a terminal transition.

1. Validate ownership, chain=4663, limits, verified import/build/harness hashes, and pinned snapshot hash using read-only RPC.
2. In one DB transaction persist immutable campaign configuration and outbox message. Dispatcher publishes job ID to BullMQ then marks outbox delivered.
3. Worker claims job, checks idempotency/state and resource budget. Create fresh sandbox from approved image; mount source read-only; write harness and config to bounded scratch volume.
4. Start local Anvil fork pinned to block; configure runner to use loopback only. Apply OS/network policy before process starts. Forge runs invariant suite with fixed seed and limits.
5. Capture stdout/stderr, traces and minimized failing sequence under limits. Hash all artifacts and upload to private object storage.
6. Persist terminal result/event atomically; terminate process/container and remove scratch volume. Reconcile stale jobs after worker loss.

Forge's own exit status and test output are the source of truth; no simulated progress, result, or coverage is reported as execution evidence.
