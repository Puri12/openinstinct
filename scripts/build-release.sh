#!/usr/bin/env sh
# Builds the release archive: dist/openinstinct-<version>-darwin-arm64.tar.gz
# plus a .sha256 sidecar.
#
# The archive is the whole product: the daemon source, its lockfiles, the
# prebuilt menu-bar panel, the prebuilt presence helper, a bun runtime, and the
# gjc binary pinned to the vendored SDK. scripts/install-remote.sh fetches it
# with curl, which never attaches com.apple.quarantine, so nothing here is
# Gatekeeper-assessed and no code-signing certificate is involved.
set -eu

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
repo_root=$(CDPATH= cd "$script_dir/.." && pwd)
version=$(git -C "$repo_root" describe --tags --always 2>/dev/null || echo dev)
arch=$(uname -m)
dist="$repo_root/dist"
name="openinstinct-$version-darwin-$arch"
stage="$dist/stage"
payload="$stage/$name"

rm -rf "$stage"
mkdir -p "$payload"

# Panel and presence helper are compiled here so the archive needs no toolchain.
# The panel bakes the release version into its Info.plist so it can compare
# itself against GitHub's latest release and offer an update.
OI_VERSION="$version" bash "$repo_root/scripts/build-panel.sh" >/dev/null
swift build --package-path "$repo_root/presence" -c release >/dev/null

# Installed as ~/.openinstinct/VERSION by bootstrap-from-payload.sh; the panel
# reads it to know what is running.
printf '%s\n' "$version" > "$payload/VERSION"

cp -R "$repo_root/daemon" "$payload/daemon"
rm -rf "$payload/daemon/node_modules"
# Tests and their fixtures are development-only and never run from an install,
# so they stay out of the archive entirely.
rm -rf "$payload/daemon/test"
cp -R "$repo_root/scripts" "$payload/scripts"
cp -R "$repo_root/docs" "$payload/docs"
cp "$repo_root/package.json" "$repo_root/bun.lock" "$repo_root/tsconfig.json" "$payload/"

mkdir -p "$payload/presence/.build/release"
cp "$repo_root/presence/.build/release/oi-presence" "$payload/presence/.build/release/"
cp "$repo_root/presence/LICENSE.platform-imessage" "$payload/presence/"

mkdir -p "$payload/panel/.build" "$payload/panel/Assets"
cp -R "$repo_root/panel/.build/OpenInstinctPanel.app" "$payload/panel/.build/"
cp "$repo_root/panel/Assets/OpenInstinct.icns" "$payload/panel/Assets/"

# The daemon *is* bun (install.sh copies it to bin/openinstinctd), so the
# runtime ships with the archive rather than being a prerequisite.
cp "$(command -v bun)" "$payload/bun"
chmod 755 "$payload/bun"

# gjc: exactly the version of the vendored SDK, so an install never depends on
# whatever gjc the host happens to have.
sdk_version=$(sed -nE 's/.*"@gajae-code\/coding-agent": *"([0-9][^"]*)".*/\1/p' "$repo_root/daemon/package.json" | head -1)
[ -n "$sdk_version" ] || { echo "cannot read SDK version from daemon/package.json" >&2; exit 1; }
case "$arch" in
  arm64) gjc_asset=gjc-darwin-arm64 ;;
  x86_64) gjc_asset=gjc-darwin-x64 ;;
  *) echo "unsupported architecture: $arch" >&2; exit 1 ;;
esac
curl -fsSL "https://github.com/Yeachan-Heo/gajae-code/releases/download/v$sdk_version/$gjc_asset" -o "$payload/gjc"
chmod 755 "$payload/gjc"

mkdir -p "$dist"
out="$dist/$name.tar.gz"
rm -f "$out" "$out.sha256"
tar -czf "$out" -C "$stage" "$name"
rm -rf "$stage"

# install-remote.sh verifies the download against this.
shasum -a 256 "$out" | sed 's| .*/| |' > "$out.sha256"

printf '%s\n' "$out"
