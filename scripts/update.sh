#!/usr/bin/env sh
# Updates an installed OpenInstinct to a GitHub release (default: latest).
#
#   sh ~/.openinstinct/src/scripts/update.sh [tag]
#
# The menu-bar panel runs this. install.sh restarts the panel partway through,
# so the work happens in a detached copy of this script (nohup, no controlling
# terminal) that outlives the panel process which launched it. Everything is
# logged to ~/.openinstinct/logs/update.log; the panel shows the tail of that
# log if the run did not end with the "done" marker.
set -eu

home_dir=${HOME:?HOME must be set}
state_home="$home_dir/.openinstinct"
log="$state_home/logs/update.log"
release=${1:-latest}
installer="$state_home/src/scripts/install-remote.sh"

[ -f "$installer" ] || { printf 'error: %s is missing; reinstall from the website\n' "$installer" >&2; exit 1; }
mkdir -p "$state_home/logs"

if [ "${OI_UPDATE_DETACHED:-0}" != "1" ]; then
  OI_UPDATE_DETACHED=1 nohup sh "$0" "$release" >"$log" 2>&1 </dev/null &
  exit 0
fi

printf '== update to %s started %s\n' "$release" "$(date '+%Y-%m-%dT%H:%M:%S%z')"
OI_RELEASE="$release" sh "$installer"
printf '== update done %s\n' "$(cat "$state_home/VERSION" 2>/dev/null || echo unknown)"
