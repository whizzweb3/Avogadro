#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
repo_root=$(CDPATH= cd -- "$script_dir/../.." && pwd -P)
. "$script_dir/docker-profile.sh"

command -v docker >/dev/null 2>&1 || { echo "Docker is required for runtime isolation tests" >&2; exit 69; }
docker info >/dev/null 2>&1 || { echo "Docker daemon is unavailable" >&2; exit 69; }

image=avogadro-forge-sandbox:v1.8.5
docker build --pull -t "$image" -f "$script_dir/Dockerfile" "$script_dir"
scratch=$(mktemp -d)
probe_job="avogadro-isolation-probe-$$"
cleanup() {
  docker rm -f "$probe_job" >/dev/null 2>&1 || true
  rm -rf "$scratch"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -p "$scratch/import/src" "$scratch/harness/test"

cat > "$scratch/import/src/Counter.sol" <<'EOF'
// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;
contract Counter { uint256 public value; function increment() external { value++; } }
EOF
cat > "$scratch/harness/test/Counter.t.sol" <<'EOF'
// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;
import { Counter } from "../src/Counter.sol";
contract CounterTest {
    Counter counter;
    function setUp() public { counter = new Counter(); }
    function testIncrement() public { counter.increment(); require(counter.value() == 1); }
}
EOF

echo "Running an isolated Foundry fixture"
sh "$script_dir/run-job.sh" "$scratch/import" "$scratch/harness"

timeout_job="avogadro-timeout-probe-$$"
echo "Verifying host timeout kills and removes a running per-job container"
set +e
timeout --signal=TERM --kill-after=5 5 \
  sh "$script_dir/docker-run.sh" "$timeout_job" \
    --entrypoint sleep "$image" 60
timeout_status=$?
set -e
[ "$timeout_status" -eq 124 ] || {
  echo "expected container timeout exit 124, got $timeout_status" >&2
  exit 1
}
docker rm -f "$timeout_job" >/dev/null 2>&1 || true
if docker ps -a --format '{{.Names}}' | grep -E '^avogadro-timeout-probe-' >/dev/null; then
  echo "timed-out job container was not cleaned up" >&2
  exit 1
fi

# Keep the same profile for a fixed, repository-owned runtime probe. Inspect
# the live container's effective Docker settings while the probe runs, then
# test the actual root filesystem, read-only mounts, scratch space and egress.
avogadro_sandbox_run "$probe_job" \
  --mount "type=bind,src=$scratch/import,dst=/input,readonly" \
  --entrypoint node "$image" /opt/avogadro/isolation-probe.mjs >"$scratch/probe.log" 2>&1 &
probe_pid=$!
found=false
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if docker inspect "$probe_job" >/dev/null 2>&1; then found=true; break; fi
  sleep 0.2
done
[ "$found" = true ] || { cat "$scratch/probe.log" >&2; echo "isolation probe did not start" >&2; exit 1; }

assert_inspect() {
  key=$1 expected=$2
  actual=$(docker inspect -f "$key" "$probe_job")
  [ "$actual" = "$expected" ] || {
    echo "container policy mismatch: expected $key=$expected, got $actual" >&2
    exit 1
  }
}
assert_inspect '{{.HostConfig.NetworkMode}}' none
assert_inspect '{{.HostConfig.ReadonlyRootfs}}' true
assert_inspect '{{.Config.User}}' '10001:10001'
assert_inspect '{{.HostConfig.Memory}}' 1073741824
assert_inspect '{{.HostConfig.MemorySwap}}' 1073741824
assert_inspect '{{.HostConfig.NanoCpus}}' 1000000000
assert_inspect '{{.HostConfig.PidsLimit}}' 64
assert_inspect '{{range .HostConfig.Ulimits}}{{if eq .Name "nofile"}}{{.Hard}}:{{.Soft}}{{end}}{{end}}' '256:256'
assert_inspect '{{json .HostConfig.CapDrop}}' '["ALL"]'
assert_inspect '{{json .HostConfig.SecurityOpt}}' '["no-new-privileges:true"]'
assert_inspect '{{json .HostConfig.Tmpfs}}' '{"/work":"rw,noexec,nosuid,nodev,size=256m,mode=1777"}'
mounts=$(docker inspect -f '{{range .Mounts}}{{.Destination}}={{.RW}} {{end}}' "$probe_job")
mount_count=0
for mount in $mounts; do
  mount_count=$((mount_count + 1))
  case "$mount" in /input=false|/work=true) ;; *) echo "unexpected mount: $mount" >&2; exit 1 ;; esac
done
[ "$mount_count" -eq 1 ] || { echo "unexpected mount set: $mounts" >&2; exit 1; }
if docker inspect -f '{{range .Mounts}}{{.Source}} {{end}}' "$probe_job" | grep -q '/var/run/docker.sock'; then
  echo "sandbox must never receive the Docker daemon socket" >&2
  exit 1
fi

set +e
wait "$probe_pid"
probe_status=$?
set -e
cat "$scratch/probe.log"
[ "$probe_status" -eq 0 ] || exit "$probe_status"
if docker ps -a --format '{{.Names}}' | grep -Fx "$probe_job" >/dev/null; then
  echo "completed sandbox container was not cleaned up" >&2
  exit 1
fi
echo "PASS per-job container policy and runtime denial checks"
