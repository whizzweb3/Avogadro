# Local worker isolation boundary

The Compose worker is an orchestration prototype, not a hardened execution sandbox. It runs as a non-root UID with a read-only root filesystem, all Linux capabilities dropped, `no-new-privileges`, a PID cap, one CPU, a 1 GiB memory cap, and a bounded no-exec `/tmp`. Its only network is `worker-isolated`, a Docker internal network that provides Redis access and no external route. The worker receives no RPC endpoint, database URL, signing key, object-store credential, or host mount. The only queue payload accepted is `{ "campaignId": "..." }`.

Compose network isolation and container settings are defense in depth, not a strong boundary against hostile compiler code or a kernel/container-runtime exploit. The current worker deliberately fails jobs closed because no sandboxed Foundry runner is wired yet. Do not run untrusted build scripts through this worker. Production execution must use a disposable microVM/VM sandbox with enforced network policy, per-job scratch storage, syscall filtering, process-tree teardown, artifact quotas, and an explicit scoped artifact-upload path. Mainnet transactions must never be broadcast; generated transactions belong only to a local Anvil process.

Local database, Redis, and MinIO credentials in `docker-compose.yml` are development-only values and must never be reused outside local development.
