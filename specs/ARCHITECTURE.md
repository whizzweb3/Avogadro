# Monorepo and deployment architecture

## Components
- `apps/web`: Next.js App Router + TypeScript, server-side metadata shell, client workspaces.
- `apps/api`: Node.js/Fastify + Zod; SIWE/session boundary; REST plus SSE.
- `packages/shared`: versioned schemas/enums for HTTP and worker messages.
- `packages/db`: PostgreSQL + Drizzle schema/migrations and repository adapters.
- `apps/worker` (planned): BullMQ consumer; isolated Foundry runner.
- `packages/contracts`: Foundry harnesses/fixtures; no production deployment scripts.
- `infra`: Compose services, CI, local worker boundary.
- Artifact storage: S3-compatible private bucket, immutable object keys and checksums.

## Runtime boundaries
Browser -> API (same-origin proxy in deployment) -> PostgreSQL / Redis. API authorizes users, validates and creates campaign/outbox records; queue workers consume job IDs and resolve immutable records. Workers receive only declared inputs, produce bounded artifacts, and upload via scoped time-limited credentials. SSE reads authorized campaign events. Workers have no mainnet signing keys or general egress.

## Local development
Compose provides PostgreSQL, Redis and MinIO. API and UI run on host; worker runs in a restricted container. CI uses isolated service containers and runs lint/typecheck/unit/integration/build plus Foundry fixture checks when Foundry is installed.

## Production shape (not deployed here)
Web/API behind TLS ingress; managed PostgreSQL, Redis, private S3; workers in disposable restricted containers or microVMs, one job per execution; centralized secrets, audit logs, backup/retention policy, metrics/alerts. Separate read-only mainnet RPC credentials from worker network namespace.
