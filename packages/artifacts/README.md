# Artifact storage

Campaign evidence is written with the AWS SDK for JavaScript to an S3-compatible bucket. The worker accepts only runner-generated, text evidence up to 64 KiB per object. The worker uploads under `campaigns/<campaign UUID>/attempt-<n>/<sha256>/<name>`; database metadata is inserted in the same transaction as the terminal campaign result. If the result commit fails, the worker makes a best-effort deletion of uploads. Evidence content is removed from the BullMQ return value and persisted campaign result.

The API serves artifacts only after the authenticated campaign owner check. It verifies stored length and SHA-256 before returning bytes, sets `private, no-store`, and denies access after `retainUntil`. An expired-object request also attempts deletion. Configure the bucket with an object lifecycle expiration rule for the `campaigns/` prefix matching the configured retention period; this removes abandoned uploads after worker/process crashes as well as normally expired objects. Bucket lifecycle configuration is an infrastructure prerequisite and is not automatically changed by this package.

## Environment

Configure both API and worker with `ARTIFACT_ENDPOINT`, `ARTIFACT_REGION`, `ARTIFACT_BUCKET`, `ARTIFACT_ACCESS_KEY_ID`, `ARTIFACT_SECRET_ACCESS_KEY`, and optional `ARTIFACT_RETENTION_DAYS` (default 30; range 1–3650). HTTP endpoints are accepted only for local development hosts. Create the bucket before starting services. Use distinct bucket-scoped credentials: the worker needs only `PutObject` and `DeleteObject` for `campaigns/*`; the API needs only `GetObject` and `DeleteObject` for `campaigns/*`. Neither process receives blockchain or application secrets through this adapter. Keep storage endpoint access private.

Migration `0005_campaign_artifact_metadata.sql` adds the display name and gives the restricted worker column-level insert permission only. The API database role owns artifact reads; the worker cannot read artifact metadata or update/delete rows. Expired metadata can be retained for audit; object lifecycle handles byte retention.
