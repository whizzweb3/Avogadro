#!/bin/sh
set -eu
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
. "$script_dir/docker-profile.sh"
[ "$#" -ge 2 ] || { echo "docker-run requires a job name and image" >&2; exit 64; }
job=$1
shift
avogadro_sandbox_run "$job" "$@"
