#!/bin/sh
set -eu

# Inputs are mounted read-only by the trusted host launcher. Only selected
# project directories are staged in the ephemeral /work tmpfs. Never copy a
# contract-provided foundry.toml or Forge configuration into this environment.
for input in /input/src /harness/test; do
  if [ ! -d "$input" ]; then
    echo "required input directory missing: $input" >&2
    exit 64
  fi
  if find "$input" -type l -print -quit | grep -q .; then
    echo "symbolic links are not accepted in sandbox inputs" >&2
    exit 65
  fi
done

mkdir -p /work/home /work/project/src /work/project/test
export HOME=/work/home
export XDG_CACHE_HOME=/work/home/.cache
export npm_config_cache=/work/home/.npm
cp -R /input/src/. /work/project/src/
cp -R /harness/test/. /work/project/test/

cat > /work/project/foundry.toml <<'EOF'
[profile.default]
src = "src"
test = "test"
out = "out"
cache_path = "cache"
libs = []
offline = true
ffi = false
fs_permissions = []
EOF

# No caller-provided Forge arguments, RPC URL, profile, or environment config.
# The trusted harness chooses which methods and invariants are exercised.
exec forge test --root /work/project --offline --use /usr/local/bin/solc
