# AVOGADRO

Robinhood Chain smart-contract fuzzing and invariant-testing laboratory.

## Local development

Requirements: Node.js 20+, npm 10+, Docker Compose (for PostgreSQL and Redis), and Foundry (`forge`/`anvil`) for campaign execution.

Copy `.env.example` to `.env`, then run `npm install`, `docker compose --profile worker up -d`, `npm run dev:api`, and `npm run dev:web` from the repository root. The web app runs on port 3000 and API on port 4000; Next.js proxies `/api/*` to the API.

The worker currently fails jobs closed because the isolated Foundry sandbox runner is not wired. Campaigns do not execute yet. The Foundry fixture is local-only. Fuzz-generated transactions must never be sent to a public RPC or mainnet. Mainnet access is read-only and contract verification data must be sourced from an authoritative explorer/API.

## Workspace

- `apps/web` — Next.js user interface
- `apps/api` — Fastify API and campaign lifecycle
- `packages/db` — Drizzle schema and migrations
- `packages/contracts` — Foundry harnesses and deterministic fixtures
- `packages/shared` — shared API contracts and domain types
- `infra` — local service orchestration and CI
- `specs` — product, architecture, and security specifications
