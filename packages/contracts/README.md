# AVOGADRO Foundry fixture

This package contains a deterministic invariant fixture and a deliberately
failing replay example. The failing example is excluded from the default test
profile and is run explicitly with `FOUNDRY_PROFILE=expected-failure forge test`.
It is test scaffolding only and does not describe a real contract finding.

The campaign runner prototype at `scripts/run-local.sh` starts Anvil bound to
`127.0.0.1` on chain ID 4663 and points Forge only at that local endpoint. It
does not accept a fork URL, configure a public RPC, use a signer, or broadcast
transactions. Production workers still need an external OS/container network
policy that denies egress; a shell wrapper alone is not a sandbox.

Reproducibility defaults are pinned in `foundry.toml`: exact solc version,
fuzz seed, run count, and invariant depth. Campaign records must additionally
bind source, compiler, harness, and snapshot hashes as specified in the shared
campaign lifecycle.

## Executable invariant template registry

The runner exposes only reviewed templates that map to an executable,
repository-owned Foundry invariant. The initial supported entry is
`vault-accounting-conservation-v1`, mapped to
`vault-accounting-v1::invariant_accountingMatchesSuccessfulActions`. It checks
the fixture's explicit accounting identity; it is not a general claim about an
imported contract. Other template categories remain unavailable until a
matching, reviewed fixture and its assumptions are implemented.

`replay-counterexample-v1` is an intentionally failing demonstration fixture,
selectable only through `replay-counterexample-demonstrator-v1` in the explicit
`demonstrator` category. Its description warns that it deliberately fails and
is not a security finding or a property to apply to imported contracts. Its
output preserves Forge's raw sequence, and the runner records ordered parsed
steps with separate SHA-256 hashes for the raw counterexample and parsed
sequence. Template IDs are part of the canonical execution identity and are
retained in replay metadata.
