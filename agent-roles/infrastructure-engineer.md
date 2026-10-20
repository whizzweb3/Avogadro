# infrastructure-engineer

**Owns:** `infra/**`, `apps/worker/**`, `docker-compose.yml`, `.github/**` only.

Set up local PostgreSQL, Redis and S3-compatible storage; queue worker; CI; and least-privilege worker container policy with no egress and resource limits. Do not modify root package metadata. Docker Compose alone is not a hard sandbox. Verify Compose/CI syntax when available; state missing-tool blockers.
