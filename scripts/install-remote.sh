#!/usr/bin/env sh
# One-line install, no code-signing certificate required:
#
#   curl -fsSL https://raw.githubusercontent.com/Yeachan-Heo/openinstinct/main/scripts/install-remote.sh | sh
#
# Gatekeeper only assesses files carrying com.apple.quarantine, which browsers
# attach and curl does not. So a curl-fetched build installs and launches with
# no "unidentified developer" prompt at all, signed or not.
#
# Overrides: OI_ARCHIVE=<local .tar.gz>, OI_ARCHIVE_URL=<url>,
# OI_RELEASE=<tag|latest>, OI_REPO=<owner/name>.
set -eu

repo=${OI_REPO:-Yeachan-Heo/openinstinct}
release=${OI_RELEASE:-latest}
work=""
downloaded=""

cleanup() {
  [ -n "$work" ] && rm -rf "$work" 2>/dev/null || true
  [ -n "$downloaded" ] && rm -f "$downloaded" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

say() { printf '%s\n' "$1"; }
die() { printf 'error: %s\n' "$1" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "OpenInstinct runs on macOS only."
case "${HOME:?HOME must be set}" in /*) ;; *) die "HOME must be absolute." ;; esac

arch=$(uname -m)
archive=${OI_ARCHIVE:-}
if [ -n "$archive" ]; then
  [ -f "$archive" ] || die "no such file: $archive"
else
  url=${OI_ARCHIVE_URL:-}
  if [ -z "$url" ]; then
    api="https://api.github.com/repos/$repo/releases/$( [ "$release" = "latest" ] && echo latest || echo "tags/$release" )"
    say "Looking up the $release release…"
    url=$(curl -fsSL "$api" \
      | /usr/bin/grep -o "\"browser_download_url\": *\"[^\"]*darwin-$arch\.tar\.gz\"" \
      | head -1 | sed 's/.*"\(https[^"]*\)"/\1/') \
      || die "could not reach the GitHub API"
    [ -n "$url" ] || die "the $release release has no darwin-$arch archive"
  fi
  downloaded=$(mktemp -t openinstinct).tar.gz
  say "Downloading $(basename "$url")…"
  curl -fL --progress-bar "$url" -o "$downloaded" || die "download failed"
  # Verify against the sidecar the build publishes, when it exists.
  if expected=$(curl -fsSL "$url.sha256" 2>/dev/null); then
    actual=$(/usr/bin/shasum -a 256 "$downloaded" | cut -d' ' -f1)
    expected=$(printf '%s' "$expected" | cut -d' ' -f1)
    [ "$actual" = "$expected" ] || die "checksum mismatch (expected $expected, got $actual)"
    say "Checksum verified."
  fi
  archive=$downloaded
fi

work=$(mktemp -d -t openinstinct-install)
tar -xzf "$archive" -C "$work" || die "could not extract $archive"

payload=$(find "$work" -maxdepth 2 -type f -name bun -exec dirname {} \; | head -1)
[ -n "$payload" ] && [ -f "$payload/scripts/bootstrap-from-payload.sh" ] \
  || die "this archive does not contain an OpenInstinct payload"

say "Installing into ~/.openinstinct…"
sh "$payload/scripts/bootstrap-from-payload.sh" "$payload"

say ""
say "Installed. Gajae is in your menu bar (the speech-bubble icon)."
say "Click it to finish setup — it walks you through the rest."
