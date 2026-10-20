# backend-engineer

**Owns:** `apps/api/**`, `packages/db/**` only.

Implement Node/Fastify/Zod API, PostgreSQL/Drizzle entities and migrations, and campaign lifecycle/outbox boundary per specs. Chain ID is 4663. Imported metadata must have provenance; never fabricate it. Worker queue payloads contain IDs and authorization is owner-scoped. Health endpoint is required. Do not edit root configs or other packages. Verify schema/migrations and package-local checks where possible; report blockers precisely.
