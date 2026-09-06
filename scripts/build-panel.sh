#!/usr/bin/env sh
set -eu

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
repo_root=$(CDPATH= cd "$script_dir/.." && pwd)
panel_dir="$repo_root/panel"
# Release tag (e.g. v0.3.0) from build-release.sh; "dev" for local builds.
version=${OI_VERSION:-dev}

swift build --package-path "$panel_dir" -c release
binary_dir=$(swift build --package-path "$panel_dir" -c release --show-bin-path)
app_dir="$panel_dir/.build/OpenInstinctPanel.app"

rm -rf "$app_dir"
mkdir -p "$app_dir/Contents/MacOS"
mkdir -p "$app_dir/Contents/Resources"
cp "$binary_dir/OpenInstinctPanel" "$app_dir/Contents/MacOS/OpenInstinctPanel"
cp "$panel_dir/Assets/OpenInstinct.icns" "$app_dir/Contents/Resources/OpenInstinct.icns"
cp "$panel_dir/Assets/menubar.png" "$panel_dir/Assets/menubar@2x.png" "$app_dir/Contents/Resources/"
chmod 755 "$app_dir/Contents/MacOS/OpenInstinctPanel"

cat > "$app_dir/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleExecutable</key>
  <string>OpenInstinctPanel</string>
  <key>CFBundleIdentifier</key>
  <string>com.openinstinct.panel</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>OpenInstinctPanel</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${version#v}</string>
  <key>CFBundleVersion</key>
  <string>$version</string>
  <key>CFBundleIconFile</key>
  <string>OpenInstinct</string>
  <key>LSUIElement</key>
  <true/>
</dict>
</plist>
PLIST

plutil -lint "$app_dir/Contents/Info.plist"
printf '%s\n' "$app_dir"
