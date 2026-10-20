# Contract ingestion and invariant templates

Import accepts only address and target chain. Resolve metadata through a configured explorer verification API with strict time/size limits, TLS, allowlisted endpoint, schema validation, provenance URL/time, and content hashes. Reject unverified contracts for fuzzing; do not scrape arbitrary URLs or infer source. Validate Solidity source/compiler metadata and ABI consistency before storing.

Templates are explicit harness source generators with versioned, reviewed code and required assumptions: conservation/supply, access control, monotonic accounting, bounded solvency, and user-defined predicate. Every generated harness is previewable and hashed. Templates make no claim that a property is complete or proves contract safety. User-authored properties remain attributable to their author and configuration. Unsupported selectors, proxy ambiguity, missing dependencies and constructor assumptions are surfaced before campaign launch.
