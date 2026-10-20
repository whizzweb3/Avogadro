#!/usr/bin/env bash
set -euo pipefail

# Runs only local Foundry fixtures. The expected-failure profile must fail for
# its deliberate assertion, and is never reported as a real contract finding.
command -v forge >/dev/null || { echo "forge is required" >&2; exit 127; }
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo_root/packages/contracts"

forge test --profile default --no-match-path 'test/expected-failure/**'

if FOUNDRY_PROFILE=expected-failure forge test --profile expected-failure; then
  echo "expected-failure fixture unexpectedly passed" >&2
  exit 1
else
  echo "expected-failure fixture reproduced its deliberate assertion failure (fixture only)"
fi
