# Phase 6 — Invariant Studio and execution evidence

## Product scope

Phase 6 adds a verified-contract inspection surface and a campaign laboratory for the repository's trusted Foundry fixtures. It does not make imported source executable. The supported execution mode remains `trusted_fixture`; the runner does not generate harnesses from imported ABI/source.

The UI has three task surfaces:

- **Invariant Studio:** runner-registered templates, fixture selection, bounded runs/depth/timeout, seed generation, and authenticated submission.
- **Execution Observatory:** campaign filters, persisted lifecycle events, status/outcome/configuration, attempt details, and truthful empty/error states.
- **Counterexample Explorer:** owner-scoped structured failure summaries, ordered parsed calls when Forge emitted recognizable call records, evidence hash/bytes, exact replay, reproduction JSON, and report export.

Contract records expose verification provenance, compiler metadata, ABI entries and ABI-derived callable function signatures. ABI functions are inspection-only while untrusted harness execution is disabled.

## Invariant registry and campaign contract

`packages/runner` owns the authoritative registry. The API reads it instead of defining a parallel catalog. Each advertised item maps to one allowlisted fixture ID and exact Foundry invariant test function.

Current templates:

| Template | Fixture | Classification |
| --- | --- | --- |
| `vault-accounting-conservation-v1` | `vault-accounting-v1` | Conservation invariant |
| `replay-counterexample-demonstrator-v1` | `replay-counterexample-v1` | Intentional failure demonstrator; never a deployed-contract finding |

Campaign input is Zod validated. Template IDs are unique, fixture-bound, and selected instead of legacy invariant names. Runs are 1–10,000, depth 1–512, timeout 1–300 seconds, and seeds are exactly 32 bytes. Templates, limits, seed, fixture/source identity and pinned runner/compiler versions bind into one canonical execution digest. API, worker and runner must produce the same digest. Workers reload fixture and template IDs from the owner-created PostgreSQL campaign row; queue payloads contain only the campaign UUID.

## Lifecycle and observability

PostgreSQL remains authoritative for campaign state. Campaign creation, idempotency, initial event and transactional outbox entry commit together. BullMQ dispatches only the campaign ID. A worker leases the campaign, runs the exact registry selection, stores artifacts, then persists the terminal result under the same lease. A stale lease cannot overwrite a newer attempt.

Campaign events use per-campaign monotonically increasing sequence values. API reads are owner-scoped, cursor-based, and limited to 100 rows; PostgreSQL retains the latest 2,000 events per campaign. The frontend polls authenticated endpoints while a selected campaign is active. No coverage, throughput or gas statistics are shown unless the runner persists real measurements.

## Foundry and evidence pipeline

Foundry executes the selected repository-owned test through the pinned local toolchain. The current fixtures cover one passing accounting property and one deliberate counterexample demonstrator. Forge output parsing preserves original evidence and extracts only call-like records into ordered steps; it does not invent missing addresses, function names, or decoded arguments. Parsed steps have a canonical SHA-256 alongside the raw trace artifact's hash and length.

Runner output and trace artifacts are uploaded to private S3-compatible storage before result metadata commits. PostgreSQL persists artifact identifiers, digest, media type, byte count and retention deadline. Authenticated artifact/counterexample reads check ownership and expiry, and verify bytes before returning them. Reports are bounded canonical JSON and include campaign provenance, selected template IDs, event/attempt summaries, finding metadata, artifact hashes and an evidence digest.

## Trust boundaries and security

- SIWE sessions and CSRF-protected writes remain the authentication boundary; campaign, event, report, finding and artifact reads are owner-scoped.
- The API accepts only known fixture/template identifiers. It rejects caller-provided source or harness paths.
- Worker execution is local Anvil/Forge state; no transaction broadcast or Robinhood mainnet RPC path is present.
- Campaign ranges, event pages, parsed call steps, Forge output, artifact bytes and reports are bounded.
- Worker containers have configured non-root, read-only, capability-drop, resource and network restrictions in local/CI definitions. These configuration settings alone do not prove hostile-workload isolation. Arbitrary imported Solidity stays disabled until runtime isolation is separately validated.
- CI S3Mock validates S3-compatible upload/read behavior and integrity handling. It does not prove a production storage provider's IAM or lifecycle configuration.

## API surface

See [API.md](./API.md). Phase 6 adds the runner-backed invariant catalog, bounded campaign filtering, event pages, findings and counterexample projection, and evidence report endpoints. Existing campaign creation, replay and cancellation remain owner-scoped.

## Persistence and deployment

PostgreSQL/Drizzle stores campaign template IDs, immutable invariant names, attempts, events, findings in bounded result JSON and artifact metadata. Redis/BullMQ remains the dispatch layer; worker execution remains a separate process/container. Migration `0007` adds persisted template IDs and the corresponding narrow worker read grant. Migration `0008` installs bounded event retention. CI applies all migrations against disposable PostgreSQL and checks worker grants/retention, Redis dispatch, Foundry fixtures, artifact behavior and authenticated campaign acceptance. No production deployment is part of Phase 6.

## Acceptance checks

The integration acceptance flow must use real disposable PostgreSQL, Redis/BullMQ, pinned Forge/Solc, the restricted worker configuration and S3-compatible storage. It authenticates test wallets, checks template ownership, rejects unknown templates, executes the passing fixture and deliberate failing demonstrator, reads persisted events/findings/reports as the owner, denies another wallet, validates evidence hashes and replays the same fixture configuration. Local tests may skip service-dependent cases when those services/toolchains are absent; a skipped local test is not an end-to-end pass.

## Known limits

Imported contract ABI/source inspection is available, but fuzzing imported contracts, generated harness execution, hostile-workload sandbox proof, production object-store policy enforcement, pinned-mainnet snapshot execution and measured coverage statistics remain unavailable. Their UI states must remain explicit and non-executable.
