#!/bin/sh
set -eu

# Trusted host-side launcher for one disposable Forge job. The Docker daemon
# socket is used only by this trusted process and is never mounted in the job.
# The only bind mounts are the read-only compiled source bundle and generated
# harness. All writable job data lives on a bounded, per-container tmpfs.

usage() {
  echo "usage: $0 SOURCE_DIR HARNESS_DIR" >&2
  exit 64
}
[ "$#" -eq 2 ] || usage
source_dir=$(cd "$1" && pwd -P) || usage
harness_dir=$(cd "$2" && pwd -P) || usage
image=avogadro-forge-sandbox:v1.8.5
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
. "$script_dir/docker-profile.sh"

for path in "$source_dir/src" "$harness_dir/test"; do
  [ -d "$path" ] || { echo "required directory missing: $path" >&2; exit 65; }
  if find "$path" -type l -print -quit | grep -q .; then
    echo "symbolic links are not accepted: $path" >&2
    exit 65
  fi
done

job="avogadro-job-$$-$(date +%s)"
cleanup() {
  docker rm -f "$job" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# The timeout wraps the Docker client, while the EXIT trap forcibly removes the
# named container, terminating the entire container process tree on timeout or
# host-side interruption. No environment is inherited into the container.
timeout_seconds=${AVOGADRO_SANDBOX_TIMEOUT_SECONDS:-300}
case "$timeout_seconds" in *[!0-9]*|'') echo "timeout must be an integer" >&2; exit 64 ;; esac
[ "$timeout_seconds" -ge 1 ] && [ "$timeout_seconds" -le 300 ] || {
  echo "timeout must be between 1 and 300 seconds" >&2; exit 64;
}

set +e
timeout --signal=TERM --kill-after=5 "$timeout_seconds" \
  sh "$script_dir/docker-run.sh" "$job" \
    --mount "type=bind,src=$source_dir,dst=/input,readonly" \
    --mount "type=bind,src=$harness_dir,dst=/harness,readonly" \
    "$image"
status=$?
set -e
exit "$status"
