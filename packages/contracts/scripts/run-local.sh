#!/usr/bin/env bash
set -euo pipefail

# Local-only prototype. Never accepts a user RPC URL and never broadcasts.
command -v anvil >/dev/null || { echo "anvil is required" >&2; exit 127; }
command -v forge >/dev/null || { echo "forge is required" >&2; exit 127; }

host=127.0.0.1
port="${AVOGADRO_ANVIL_PORT:-18545}"
case "$port" in *[!0-9]*|'') echo "AVOGADRO_ANVIL_PORT must be numeric" >&2; exit 2;; esac
if (( port < 1024 || port > 65535 )); then echo "port must be between 1024 and 65535" >&2; exit 2; fi

anvil --host "$host" --port "$port" --chain-id 4663 --silent &
anvil_pid=$!
cleanup() { kill "$anvil_pid" 2>/dev/null || true; wait "$anvil_pid" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

rpc="http://${host}:${port}"
ready=0
for _ in {1..50}; do
  if curl --silent --fail "$rpc" -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' | rg -q '0x1237'; then
    ready=1
    break
  fi
  sleep 0.1
done
if (( ready == 0 )); then echo "local Anvil did not become ready" >&2; exit 1; fi

cd "$(dirname "$0")/.."
forge test --profile default --fork-url "$rpc" --no-auto-detect --no-match-path 'test/expected-failure/**'
