# Worker isolation and execution boundary

## Execution contract

The worker accepts only repository-owned fixture IDs and invariant template IDs resolved by the runner allowlist. BullMQ messages contain only a campaign ID; the worker reloads authoritative configuration from PostgreSQL and leases attempts through the restricted `avogadro_worker` role. The API does not accept Solidity source, build scripts, compiler plugins, arbitrary Forge arguments, paths, shell commands, or RPC URLs. The worker receives no API session/signing credentials, wallet material, or mainnet credentials.

Forge runs offline against a local test EVM. The runner uses a fixed Forge argument list without `--broadcast` or caller-controlled arguments. These are source-level controls; they do not prove that future code, a compromised host, or a misconfigured runtime cannot reach a network or broadcast transactions.

## Local Compose controls

The worker joins only the `worker-isolated` internal bridge. PostgreSQL, Redis, and S3Mock also join that network and the backend network. The worker uses its restricted database role and a dedicated local object-store credential. It is configured with:

- UID/GID `10001:10001`, read-only root filesystem, all capabilities dropped, and `no-new-privileges`;
- one CPU, 1 GiB memory, 96 processes, and a 256 MiB `/tmp` tmpfs mounted `noexec,nosuid`;
- concurrency 1, a per-campaign Forge timeout capped at 300 seconds, and output capture capped at 64 KiB per stream;
- Forge 1.8.5 and solc 0.8.26. The solc binary is checked against a literal SHA-256 during image build. Foundry's downloaded checksum comes from the same release endpoint and is not independently pinned. The image currently supports linux/amd64 only.

Compose uses fixed local-only database and S3Mock credentials; never reuse them outside local development. S3Mock supports local API-compatibility checks but does not enforce IAM or bucket lifecycle policy. Artifact retention timestamps are metadata only; no object cleanup worker or provider lifecycle policy is configured.

## Events and evidence

Campaign events are sequence-numbered in PostgreSQL. The worker can insert events but cannot update or delete event history. A database trigger retains the latest 2,000 rows per campaign. Campaign detail returns a bounded recent timeline; the owner-scoped events endpoint retrieves bounded pages. There is no SSE transport.

The worker uploads bounded evidence to the S3-compatible endpoint under digest-addressed keys, then persists metadata (SHA-256, byte length, media type, and `retain_until`) in PostgreSQL. API retrieval is owner-authorized and verifies object length and digest. Persistence failure triggers best-effort deletion; stale attempts are fenced from committing results. Crash cleanup and provider lifecycle behavior are not guaranteed.

## Verification status and limits

CI is configured to exercise trusted fixtures with disposable PostgreSQL, Redis, S3Mock, and pinned Foundry tooling, including migrations, grants, queue dispatch, evidence retrieval, and owner checks. A passing service-level integration run does not prove Compose worker restrictions or runtime network egress denial. Local Docker/Compose, a disposable VM or microVM, custom seccomp, per-job filesystem destruction, hostile-workload escape resistance, and real provider IAM/lifecycle behavior remain unverified here.

Do not enable user-authored Solidity or build scripts until a disposable strong sandbox has enforced egress policy, per-job scratch storage, syscall filtering, process-tree teardown, artifact quotas, independent image/tool provenance, and adversarial escape/resource-exhaustion tests. Never enable generated transaction broadcast to Robinhood Chain mainnet.
