# AVOGADRO product requirements and MVP

## Purpose
AVOGADRO is a professional security lab for importing verified Robinhood Chain contracts and testing user-defined invariants through reproducible, stateful fuzzing in isolated EVMs.

## MVP capabilities
1. Import contract address and chain ID; fetch source/ABI/metadata only from a configured authoritative verification source. Clearly distinguish unavailable/unverified data; never synthesize source or results.
2. Browse imported contract metadata, source files, ABI and callable functions.
3. Configure a campaign with selected contract/build, pinned block number/hash, invariant harness, seed, run/time/gas bounds and fork settings.
4. Create invariant definitions from supported templates or explicitly authored Foundry harnesses.
5. Queue lifecycle-managed campaigns and execute only in disposable local Anvil processes with no outbound network and no signing/broadcasting capability.
6. Stream lifecycle/progress over SSE; retain real logs, failing call sequences and counterexamples.
7. Replay from immutable inputs and seed; export a manifest plus logs/traces as evidence.

## MVP exclusions
Wallet connection and transaction signing, public testnet/mainnet execution, automatic exploit generation, fabricated coverage/risk scores, Solidity editor, multi-chain support, collaborative organizations, billing, and production deployment automation.

## Acceptance criteria
- UI states empty, loading, error, unverified, and verified explicitly.
- API validates all inputs; campaign creation is idempotent and state transitions are auditable.
- A campaign pins chain ID, block number/hash, source/build digest, harness digest, seed and engine version.
- Worker cannot reach public networks or access host credentials; resource limits and timeout are enforced.
- Fixture property failure is captured and can be replayed byte-for-byte from campaign inputs.
- No generated transaction is broadcast to Robinhood Chain.
