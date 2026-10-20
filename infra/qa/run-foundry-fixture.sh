#!/usr/bin/env bash
set -euo pipefail

# Runs only local Foundry fixtures. The expected-failure profile must fail for
# its deliberate assertion, and is never reported as a real contract finding.
forge_bin="${FORGE_BIN:-forge}"
command -v "$forge_bin" >/dev/null 2>&1 || { echo "forge is required (set FORGE_BIN to its executable path)" >&2; exit 127; }
forge_solc_args=()
if [[ -n "${SOLC_BINARY:-}" ]]; then
  [[ -x "$SOLC_BINARY" ]] || { echo "SOLC_BINARY must name an executable solc" >&2; exit 2; }
  forge_solc_args=(--use "$SOLC_BINARY")
fi
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo_root/packages/contracts"

"$forge_bin" test --profile default "${forge_solc_args[@]}" --offline --no-match-path 'test/expected-failure/**'

failure_log="$(mktemp)"
trap 'rm -f "$failure_log"' EXIT
if FOUNDRY_PROFILE=expected-failure "$forge_bin" test --profile expected-failure "${forge_solc_args[@]}" --offline >"$failure_log" 2>&1; then
  echo "expected-failure fixture unexpectedly passed" >&2
  exit 1
fi
if ! rg -q 'assertion failed|assertion.*failed|test_replayCounterexample.*FAIL' "$failure_log"; then
  cat "$failure_log" >&2
  echo "expected-failure profile failed without the fixture assertion marker" >&2
  exit 1
fi
cat "$failure_log"
echo "expected-failure fixture reproduced its deliberate assertion failure (fixture only)"
