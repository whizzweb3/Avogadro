# Frontend information architecture

Dark, restrained security-workbench visual language with readable source and data tables; no invented logo. Global navigation: Overview, Contracts, Campaigns, Invariants, Artifacts. Contract workspace: identity/verification provenance, source tree/editor, ABI and callable functions, campaign launch. Campaign workspace: immutable snapshot/config, live SSE timeline, invariant outcomes, trace/counterexample and replay/export. Empty and failure states explain next step. Accessible keyboard flow, semantic landmarks, responsive down to tablet.

# Test strategy

Shared schemas: valid/invalid fixtures. API: health, input validation, auth/ownership, lifecycle transitions, SSE replay/backpressure. DB: migrate fresh disposable PostgreSQL, foreign key/unique/transaction checks. Queue: idempotency, retry, cancel and outbox recovery with disposable Redis. Runner: deterministic local Anvil/Forge fixture and fail/pass artifact replay. Sandbox: network denial, quotas, process cleanup and mount controls. UI: component tests and Playwright contract-to-campaign happy path plus loading/empty/error; mock APIs only for UI presentation, never represent mock data as real scan results. CI performs lockfile install, lint, typecheck, unit/integration/build and Foundry check.

# Deployment architecture

Containerized web/API, managed PostgreSQL/Redis, private S3-compatible artifacts, restricted isolated workers. TLS ingress; least-privilege service identities, secret manager, migrations as one-off reviewed job, health/readiness checks, logs/metrics/tracing, backups and retention. Dev Compose is local-only and uses non-production credentials. No production deployment is part of this milestone.
