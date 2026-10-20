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
