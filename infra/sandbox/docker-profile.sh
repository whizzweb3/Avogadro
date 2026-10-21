#!/bin/sh
# Shared container profile. Source only from trusted host-side launchers.
# The caller supplies mounts, image, and a fixed command; these values must not
# originate in contract input or campaign configuration.
avogadro_sandbox_run() {
  name=$1
  shift
  docker run --name "$name" \
    --pull=never \
    --network none \
    --read-only \
    --user 10001:10001 \
    --cap-drop ALL \
    --security-opt no-new-privileges:true \
    --pids-limit 64 \
    --memory 1g --memory-swap 1g \
    --cpus 1.0 \
    --ulimit nofile=256:256 --ulimit core=0 \
    --tmpfs /work:rw,noexec,nosuid,nodev,size=256m,mode=1777 \
    --log-opt max-size=1m --log-opt max-file=1 \
    "$@"
}
