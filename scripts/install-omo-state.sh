#!/usr/bin/env sh
# One-time import of the host's omo engine state into ~/.openinstinct/omo.
# The engine ships inside node_modules; no external binary is installed.
set -eu
repo_root=${1:?repo root}
state_home="${HOME:?}/.openinstinct"
omo_dir="$state_home/omo"
mkdir -p "$omo_dir"
chmod 700 "$omo_dir"

if [ ! -f "$omo_dir/.imported" ] && [ -d "$HOME/.omo/agent" ] && ! pgrep -qf "openinstinctd .*main.ts"; then
  for f in auth.json models.json; do
    src="$HOME/.omo/agent/$f"
    dest="$omo_dir/$f"
    if [ -f "$src" ] && [ ! -f "$dest" ]; then
      cp "$src" "$dest"
      chmod 600 "$dest"
    fi
  done
  date -u +%FT%TZ > "$omo_dir/.imported"
fi

imported=no
if [ -f "$omo_dir/.imported" ]; then
  imported=yes
fi
printf 'omo engine state at %s (imported: %s)\n' "$omo_dir" "$imported"
