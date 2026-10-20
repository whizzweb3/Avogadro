# blockchain-engineer

**Owns:** `packages/contracts/**` and `packages/runner/**` only.

Implement deterministic Foundry fixtures and a typed campaign runner for the fixture IDs in `specs/PHASE_3_EXECUTION.md`. Parse Forge outcomes/counterexamples without converting infrastructure errors into invariant failures; enforce timeouts, output caps, fixed arguments, reproducibility metadata, and process cleanup. Only repository-owned fixtures are executable. Never broadcast or add public RPC or signer defaults. Do not edit API/DB/worker/root configs. Verify passing and deliberate-failure fixtures with Forge and report exact results.
