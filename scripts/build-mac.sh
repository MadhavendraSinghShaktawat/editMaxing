#!/usr/bin/env bash
# Builds the web UI, compiles the Swift app and native tools, and packages
# Shifu Dojo.app with its engine and a DMG. The app needs only Claude Code and ffmpeg on the Mac.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
OUT="$ROOT/build"
APP="$OUT/Shifu Dojo.app"
VERSION="$(node -p "require('./package.json').version")"

npm run build
swift build -c release --package-path mac

rm -rf "$APP" "$OUT/ShifuDojo.dmg"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "mac/.build/release/ShifuDojo" "$APP/Contents/MacOS/ShifuDojo"
cp "mac/.build/release/dojo-native" "$APP/Contents/Resources/dojo-native"

# The engine runs on a bundled Node, so teammates don't need to install one. Apple Silicon only.
lipo -thin arm64 "$(node -p process.execPath)" -output "$APP/Contents/MacOS/node" 2>/dev/null || cp "$(node -p process.execPath)" "$APP/Contents/MacOS/node"
cp -R dist "$APP/Contents/Resources/dist"
mkdir -p "$APP/Contents/Resources/engine" "$APP/Contents/Resources/library"
cp -R engine/src "$APP/Contents/Resources/engine/src"
cp -R library/plugin "$APP/Contents/Resources/library/plugin"

# Production dependencies only. Chats use the Mac's own claude binary, so the SDK's optional 300 MB copy stays out.
DEPS="$(mktemp -d)"
node -e '
  const p = require("./package.json");
  const pick = ["@anthropic-ai/claude-agent-sdk", "zod"];
  require("fs").writeFileSync(process.argv[1] + "/package.json", JSON.stringify({ private: true, type: "module", dependencies: Object.fromEntries(pick.map((k) => [k, p.dependencies[k]])) }));
' "$DEPS"
(cd "$DEPS" && npm install --silent --omit=dev --omit=optional --no-audit --no-fund)
cp "$DEPS/package.json" "$APP/Contents/Resources/package.json"
cp -R "$DEPS/node_modules" "$APP/Contents/Resources/node_modules"

ICONSET="$(mktemp -d)/AppIcon.iconset"
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" mac/Resources/AppIcon.png --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z "$double" "$double" mac/Resources/AppIcon.png --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Shifu Dojo</string>
  <key>CFBundleDisplayName</key><string>Shifu Dojo</string>
  <key>CFBundleIdentifier</key><string>ai.socialshifu.dojo</string>
  <key>CFBundleExecutable</key><string>ShifuDojo</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>26.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.video</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

# Ad-hoc signed for local use. Public downloads need a Developer ID signature and notarization.
codesign --force --deep --sign - "$APP"

STAGE="$(mktemp -d)"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
hdiutil create -quiet -volname "Shifu Dojo" -srcfolder "$STAGE" -ov -format UDZO "$OUT/ShifuDojo.dmg"

echo "App: $APP"
echo "DMG: $OUT/ShifuDojo.dmg"
