#!/usr/bin/env sh
set -eu

home_dir=${HOME:?HOME must be set}
uid=$(id -u)
plist="$home_dir/Library/LaunchAgents/co.openinstinct.daemon.plist"
binary="$home_dir/.openinstinct/bin/openinstinctd"
library="$home_dir/.openinstinct/lib"

if launchctl print "gui/$uid/co.openinstinct.daemon"; then
  launchctl bootout "gui/$uid" "$plist"
fi
rm -f "$plist" "$binary"
rm -rf "$library"
launchctl bootout "gui/$(id -u)/co.openinstinct.panel" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/co.openinstinct.panel.plist"
rm -rf "$HOME/Applications/OpenInstinctPanel.app"
