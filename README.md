# AVOGADRO

Robinhood Chain smart-contract fuzzing and invariant-testing laboratory.

## Local development

Requirements: Node.js 20+, npm 10+, Docker Compose (for PostgreSQL and Redis), and pinned Foundry/solc for local fixture execution. The worker image installs checksum-verified Forge 1.8.5 and solc 0.8.26 for linux/amd64.

Copy `.env.example` to `.env`, install dependencies with `npm ci`, then start PostgreSQL and Redis with `docker compose up -d postgres redis`. Apply schema migrations with `npm run db:migrate --workspace @avogadro/db` after providing the local `DATABASE_URL`. Start API and web in separate terminals with `npm run dev:api` and `npm run dev:web`; the web app runs on port 3000 and proxies `/api/*` to the API on port 4000. Configure `SIWE_DOMAIN`, `SIWE_URI`, and `SIWE_CHAIN_ID=4663` before wallet sign-in. Start the isolated worker only after migrations and local dependencies are ready: `docker compose --profile worker up --build -d worker`.

Phase 3 campaign execution is limited to the two committed fixtures (`vault-accounting-v1` and `replay-counterexample-v1`) on local test-EVM state. The second fixture is a deliberate invariant violation used to verify counterexample replay; it is not a finding against a deployed contract. Imported contract source is not executed, mainnet fork execution is disabled, and no generated transaction is broadcast. The Compose worker has resource/network restrictions, but its image/runtime isolation was not verified in this environment and is not considered a strong hostile-code sandbox.

PostgreSQL and Docker were unavailable in the current environment, so the schema migration, database-backed API/worker flow, container build, and runtime network boundary still require verification on a Docker-enabled host. Local Redis and actual pinned Foundry fixtures were independently exercised. See [Phase 3 execution](specs/PHASE_3_EXECUTION.md) and [security review](specs/SECURITY_REVIEW.md) for exact scope and remaining blockers.

## Workspace

- `apps/web` — Next.js user interface
- `apps/api` — Fastify API and campaign lifecycle
- `packages/db` — Drizzle schema and migrations
- `packages/contracts` — Foundry harnesses and deterministic fixtures
- `packages/shared` — shared API contracts and domain types
- `infra` — local service orchestration, worker isolation configuration and CI
- `specs` — product, architecture, and security specifications
