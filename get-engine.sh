#!/bin/sh
# Downloads the Rapfi release this project drives and unpacks the build for this
# platform, its weights and its config into engine/. Rapfi is GPL-3.0 and is not
# committed to this repository; see README.md. Windows has get-engine.cmd.
set -eu
cd "$(dirname "$0")"

TAG=250615
URL="https://github.com/dhbloo/rapfi/releases/download/$TAG/Rapfi-engine.7z"
ARCHIVE="${TMPDIR:-/tmp}/Rapfi-engine-$TAG.7z"

case "$(uname -s)" in
  Darwin)
    # The release carries one macOS binary and it is arm64 only.
    if [ "$(uname -m)" != "arm64" ]; then
      echo "The macOS build in this release is Apple Silicon only, and this is $(uname -m)."
      echo "Build Rapfi from source (https://github.com/dhbloo/rapfi) or let the page"
      echo "fall back to the built-in engine."
      exit 1
    fi
    PATTERN="pbrain-rapfi-macos-apple-silicon"
    ;;
  Linux)
    PATTERN="pbrain-rapfi-linux-clang-*"
    ;;
  *)
    echo "Unsupported platform $(uname -s). On Windows run get-engine.cmd."
    exit 1
    ;;
esac

# libarchive reads 7z, and on macOS that is the system tar. Elsewhere fall back
# to whatever 7-Zip is installed; GNU tar cannot open these archives.
if tar --version 2>/dev/null | grep -qi bsdtar; then
  UNPACK=bsdtar
elif command -v bsdtar >/dev/null 2>&1; then
  UNPACK=bsdtar-cmd
elif command -v 7zz >/dev/null 2>&1; then
  UNPACK=7zz
elif command -v 7z >/dev/null 2>&1; then
  UNPACK=7z
elif command -v 7za >/dev/null 2>&1; then
  UNPACK=7za
else
  echo "No tool here can unpack a .7z archive."
  echo "Install one with:  brew install sevenzip   (or apt install p7zip-full)"
  exit 1
fi

echo "Downloading Rapfi $TAG engine package, about 35 MB."
curl -L --fail --progress-bar -o "$ARCHIVE" "$URL"

mkdir -p engine
echo "Unpacking the $(uname -s) build, weights and config."
case "$UNPACK" in
  bsdtar)     tar -xf "$ARCHIVE" -C engine "$PATTERN" "*.bin" "*.bin.lz4" config.toml AUTHORS ;;
  bsdtar-cmd) bsdtar -xf "$ARCHIVE" -C engine "$PATTERN" "*.bin" "*.bin.lz4" config.toml AUTHORS ;;
  *)          "$UNPACK" x -y -o"engine" "$ARCHIVE" "$PATTERN" "*.bin" "*.bin.lz4" config.toml AUTHORS >/dev/null ;;
esac

chmod +x engine/pbrain-rapfi-* 2>/dev/null || true
# A browser download would carry a quarantine flag that stops the binary running.
[ "$(uname -s)" = "Darwin" ] && xattr -dr com.apple.quarantine engine 2>/dev/null || true

rm -f "$ARCHIVE"
echo
echo "Done. Run ./mac_play.sh to start."
