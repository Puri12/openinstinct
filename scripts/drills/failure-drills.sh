#!/usr/bin/env sh
set -eu

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
repo_root=$(CDPATH= cd "$script_dir/../.." && pwd)
fixture="$script_dir/fixture.ts"
cd "$repo_root"
work_root=$(mktemp -d "${TMPDIR:-/tmp}/openinstinct-failure-drills.XXXXXX")
current_pid=""
failures=0

cleanup() {
  if [ -n "$current_pid" ] && kill -0 "$current_pid" 2>/dev/null; then
    kill -9 "$current_pid" || true
    wait "$current_pid" || true
  fi
  rm -rf "$work_root"
}
trap cleanup EXIT INT TERM

wait_for_file() {
  path=$1
  attempts=${2:-200}
  while [ "$attempts" -gt 0 ]; do
    if [ -e "$path" ]; then
      return 0
    fi
    sleep 0.1
    attempts=$((attempts - 1))
  done
  return 1
}

wait_for_hold() {
  log=$1
  point=$2
  attempts=300
  while [ "$attempts" -gt 0 ]; do
    if [ -f "$log" ] && grep -Fq "OI_DRILL_HOLD_REACHED $point" "$log"; then
      return 0
    fi
    sleep 0.1
    attempts=$((attempts - 1))
  done
  return 1
}

wait_for_assertion() {
  drill=$1
  home=$2
  first_log=${3:-}
  attempts=300
  while [ "$attempts" -gt 0 ]; do
    if HOME="$home" bun "$fixture" assert "$drill" "$home" "$first_log" >"$home/assert.out"; then
      return 0
    fi
    sleep 0.1
    attempts=$((attempts - 1))
  done
  HOME="$home" bun "$fixture" assert "$drill" "$home" "$first_log" || true
  return 1
}

start_daemon() {
  home=$1
  log=$2
  hold=${3:-}
  if [ -n "$hold" ]; then
    HOME="$home" OI_DRILL_MODE=1 OI_DRILL_HOLD="$hold" bun daemon/src/main.ts >"$log" &
  else
    HOME="$home" OI_DRILL_MODE=1 bun daemon/src/main.ts >"$log" &
  fi
  current_pid=$!
}

stop_daemon() {
  if [ -n "$current_pid" ]; then
    kill -9 "$current_pid" || true
    wait "$current_pid" || true
    current_pid=""
  fi
}

run_drill() {
  drill=$1
  hold=$2
  home="$work_root/$drill/home"
  first_log="$work_root/$drill/first.log"
  second_log="$work_root/$drill/second.log"
  mkdir -p "$(dirname "$home")"

  if ! HOME="$home" bun "$fixture" seed "$drill" "$home"; then
    printf '%s\n' "DRILL $drill FAIL: fixture seed failed"
    return 1
  fi

  start_daemon "$home" "$first_log" "$hold"
  if [ -n "$hold" ]; then
    if ! wait_for_hold "$first_log" "$hold"; then
      stop_daemon
      printf '%s\n' "DRILL $drill FAIL: did not reach $hold seam"
      return 1
    fi
  elif ! wait_for_file "$home/.openinstinct/run/control.sock"; then
    stop_daemon
    printf '%s\n' "DRILL $drill FAIL: first daemon did not expose control socket"
    return 1
  fi
  stop_daemon

  start_daemon "$home" "$second_log"
  if ! wait_for_file "$home/.openinstinct/run/control.sock"; then
    stop_daemon
    printf '%s\n' "DRILL $drill FAIL: restart did not expose control socket"
    return 1
  fi
  if ! wait_for_assertion "$drill" "$home" "$first_log"; then
    stop_daemon
    printf '%s\n' "DRILL $drill FAIL: recovery invariant was not satisfied"
    return 1
  fi
  stop_daemon
  printf '%s\n' "DRILL $drill PASS"
}

run_live_drill() {
  drill=$1
  hold=$2
  home="$work_root/$drill/home"
  first_log="$work_root/$drill/first.log"
  mkdir -p "$(dirname "$home")"

  if ! HOME="$home" bun "$fixture" seed "$drill" "$home"; then
    printf '%s\n' "DRILL $drill FAIL: fixture seed failed"
    return 1
  fi
  start_daemon "$home" "$first_log" "$hold"
  if ! wait_for_hold "$first_log" "$hold"; then
    stop_daemon
    printf '%s\n' "DRILL $drill FAIL: did not reach $hold seam"
    return 1
  fi
  if ! wait_for_assertion "$drill" "$home" "$first_log"; then
    stop_daemon
    printf '%s\n' "DRILL $drill FAIL: live invariant was not satisfied"
    return 1
  fi
  stop_daemon
  printf '%s\n' "DRILL $drill PASS"
}

for spec in \
  "mid-turn:mid-turn" \
  "mid-child:mid-child" \
  "post-journal-pre-receipt:post-journal-pre-receipt" \
  "mid-closure:mid-closure" \
  "mid-propagation:mid-propagation" \
  "mid-interim-batch:mid-interim-batch" \
  "paused-state:"; do
  drill=${spec%%:*}
  hold=${spec#*:}
  if ! run_drill "$drill" "$hold"; then
    failures=$((failures + 1))
  fi
done
if ! run_live_drill "child-tools-while-held" "mid-child"; then
  failures=$((failures + 1))
fi

if [ "$failures" -ne 0 ]; then
  printf '%s\n' "METRIC failure_drills=fail failures=$failures"
  exit 1
fi
printf '%s\n' "METRIC failure_drills=pass"
