# Threat model and worker isolation

## Assets and boundaries
Wallet identities/sessions, private source/import data, API/database credentials, artifact integrity and host/cloud credentials. Trust zones: browser, API, DB/queue, ingestion RPC, execution worker, artifact store.

## Threats
Malicious Solidity/build scripts and compiler plugins; source/dependency supply-chain attacks; RPC SSRF or malicious data; forked contract behavior; resource exhaustion; cross-tenant IDOR; queue tampering/replay; artifact poisoning; forged SIWE; SSE leakage; accidental real transaction broadcast; compromised worker escape.

## Controls
SIWE nonce single-use, domain/URI/chain/time validation, secure session cookies, CSRF defense, ownership checks on every object, rate limits. RPC egress restricted to ingestion control plane and never user-supplied URLs. Queue payload contains IDs only; DB remains authoritative. Workers get no application secrets/signers, run non-root in disposable sandbox with no network namespace egress, read-only root/source, bounded writable tmpfs, CPU/memory/PID/time/output quotas, syscall profile and seccomp; image pinned/digest verified. One campaign per sandbox; kill process tree and destroy storage after completion. Reject arbitrary `--fork-url`, FFI, shell hooks and networked dependency resolution. Artifacts size capped, checksummed, private, content-disposition attachment. Audit all state transitions and admin access.

## Residual risks
Container isolation alone is not a hard boundary for hostile compiler code; production worker should use microVM/VM isolation. Foundry/solc versions and dependency lockfiles must be pinned. Oracle/RPC truth and invariant quality cannot be guaranteed by platform.

## Validation
Test attempts to reach metadata/private networks, access host mounts, exceed CPU/memory/time/output, escape via child process and access another user's records. Fail closed if sandbox/network enforcement unavailable.
