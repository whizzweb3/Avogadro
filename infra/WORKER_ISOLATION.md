# Local worker isolation boundary

## Execution contract

Compose worker accepts only repository-owned fixture IDs through the `@avogadro/runner` allowlist. BullMQ messages contain only `{ "campaignId": "..." }`; the worker reloads the authoritative campaign row and renews its attempt lease through PostgreSQL. It receives `DATABASE_URL` for the restricted worker role and Redis host/port on Compose's internal `worker-isolated` network. It receives no RPC endpoint, signer, wallet material or object-store credential. Forge runs offline against a local test EVM; pinned block metadata is not used for fork execution in this phase.

Runner uses a fixed Forge argument list without `--broadcast`, caller-controlled flags, source paths, RPC URL, shell command or inherited application credentials. `FOUNDRY_OFFLINE=true` is set. This describes source-level configuration; it is not runtime evidence that the container has no external egress or that mainnet broadcast is impossible under every future configuration.

## Local Compose controls

`docker-compose.yml` places the worker only on `worker-isolated`, an internal bridge. PostgreSQL and Redis join both backend and worker-isolated networks, so API/local services can use backend while the worker can reach its DB and queue. The worker is configured with:

- UID/GID `10001:10001`, read-only root filesystem, all capabilities dropped and `no-new-privileges`;
- one CPU, 1 GiB memory, 96 processes and a 256 MiB `/tmp` tmpfs mounted `noexec,nosuid`;
- worker concurrency 1, with per-campaign Forge timeout capped at 300 seconds and output capture capped at 64 KiB per stream;
- pinned Forge version 1.8.5 and solc 0.8.26. The solc binary is checked against a literal SHA-256 during image build. The Foundry archive is checked against a checksum file downloaded from the same release endpoint, so that checksum is not independently pinned. The image currently supports linux/amd64 only.

These are local Compose controls. Postgres and Redis images use mutable major-version tags; the worker Node base is a mutable version tag. Compose contains fixed local-only DB, worker and MinIO credentials. Do not reuse them outside local development. Production must use managed secrets and immutable/digest-pinned images with independent tool checksums.

## Database grants and migration ordering

`infra/postgres/worker-role.sql` creates the local `avogadro_worker` role when the Postgres data directory is initialized. Migration `0002_phase3_campaigns.sql` conditionally grants worker column privileges only if that role exists when the migration executes. Therefore create the role before applying migrations in any environment that needs the worker. The migration does not create the role itself. Effective grants, query `RETURNING` privileges and denied access to user/session/contract/source tables require runtime validation against PostgreSQL; source review alone is not sufficient.

## Limits and remaining boundary

Compose settings and Node process-group termination are defense in depth, not a strong boundary against hostile compiler code or a kernel/container-runtime exploit. This is not a per-job sandbox: there is no disposable VM/microVM, custom seccomp profile, per-job scratch mount lifecycle, or adversarial escape/egress validation. Imported contract source and user-provided build scripts remain ineligible. Runner setup work such as copying and hashing the trusted fixture tree does not share a single campaign-wide supervisor deadline; the Forge process itself has the configured timeout.

Runner bounds captured output and cleans temporary scratch in `finally`, but resulting output and counterexample content are currently persisted in PostgreSQL result JSON. MinIO/S3-compatible object storage is present only as a local Compose service and is not connected to the artifact flow. There is no owner-scoped object retrieval/export or artifact retention cleanup yet.

Before user-source execution, require a disposable strong sandbox with enforced egress policy, per-job scratch storage, syscall filtering, process-tree teardown, artifact quotas and a reviewed upload path. Execute filesystem, network, syscall, resource-exhaustion, process-cleanup and escape-denial checks under the exact deployment boundary. Never enable generated transaction broadcast to Robinhood Chain mainnet.

**Runtime status:** Docker/Compose startup, image build, migration application, worker DB grants and network isolation must be recorded as verified only after they have been executed in the target environment. Configuration inspection by itself is not validation.
