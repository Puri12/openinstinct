#!/usr/bin/env sh
set -eu

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
repo_root=$(CDPATH= cd "$script_dir/.." && pwd)
source_dir="$repo_root/daemon/test/fixtures/control"
target_dir="$repo_root/panel/Tests/OpenInstinctPanelTests/Resources/control"

rm -rf "$target_dir"
mkdir -p "$target_dir"
cp "$source_dir"/*.json "$target_dir"/
