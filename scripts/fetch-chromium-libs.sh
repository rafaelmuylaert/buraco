#!/usr/bin/env bash
# Download + extract the shared libraries headless Chromium needs, WITHOUT
# root/apt (for locked-down hosts). Extracts each .deb into its own dir under
# $LIBS_DIR, then symlinks the DejaVu font dir for use by fonts.conf.
#
# Requires: python3 (for downloading) and dpkg-deb (for extraction). No curl
# or apt needed.
#
# Usage:
#   bash scripts/fetch-chromium-libs.sh [LIBS_DIR]
#   # LIBS_DIR defaults to scripts/.chromium-libs
#
# After running, build LD_LIBRARY_PATH from the extracted dirs:
#   export LD_LIBRARY_PATH=$(ls -d "$LIBS_DIR"/*/usr/lib/x86_64-linux-gnu | tr '\n' ':')
#
# NOTE: if you CAN use apt, prefer installing the real packages instead (see
# scripts/README.md "System dependencies") — then you do not need this script.
set -euo pipefail

BASE="http://deb.debian.org/debian"
LIBS_DIR="${1:-$(cd "$(dirname "$0")" && pwd)/.chromium-libs}"
DEBS_DIR="$LIBS_DIR/.debs"
mkdir -p "$DEBS_DIR" "$LIBS_DIR"

# Debian 13 (trixie) amd64 package files, relative to $BASE.
files=(
  "pool/main/g/glib2.0/libglib2.0-0t64_2.84.4-3~deb13u5_amd64.deb"
  "pool/main/n/nspr/libnspr4_4.36-1_amd64.deb"
  "pool/main/n/nss/libnss3_3.110-1+deb13u4_amd64.deb"
  "pool/main/a/at-spi2-core/libatk1.0-0t64_2.56.2-1+deb13u2_amd64.deb"
  "pool/main/a/at-spi2-core/libatk-bridge2.0-0t64_2.56.2-1+deb13u2_amd64.deb"
  "pool/main/a/at-spi2-core/libatspi2.0-0t64_2.56.2-1+deb13u2_amd64.deb"
  "pool/main/d/dbus/libdbus-1-3_1.16.2-2_amd64.deb"
  "pool/main/libx/libx11/libx11-6_1.8.12-1_amd64.deb"
  "pool/main/libx/libxcomposite/libxcomposite1_0.4.6-1+b2_amd64.deb"
  "pool/main/libx/libxdamage/libxdamage1_1.1.6-1+b2_amd64.deb"
  "pool/main/libx/libxext/libxext6_1.3.4-1+b3_amd64.deb"
  "pool/main/libx/libxfixes/libxfixes3_6.0.0-2+b4_amd64.deb"
  "pool/main/libx/libxrandr/libxrandr2_1.5.4-1+b3_amd64.deb"
  "pool/main/libx/libxcb/libxcb1_1.17.0-2+b1_amd64.deb"
  "pool/main/libx/libxkbcommon/libxkbcommon0_1.7.0-2_amd64.deb"
  "pool/main/libx/libxau/libxau6_1.0.11-1_amd64.deb"
  "pool/main/libx/libxdmcp/libxdmcp6_1.1.5-1_amd64.deb"
  "pool/main/libx/libxi/libxi6_1.8.2-1_amd64.deb"
  "pool/main/libx/libxrender/libxrender1_0.9.12-1+b3_amd64.deb"
  "pool/main/m/mesa/libgbm1_25.0.7-2+deb13u1_amd64.deb"
  "pool/main/libdrm/libdrm2_2.4.124-2_amd64.deb"
  "pool/main/a/alsa-lib/libasound2t64_1.2.14-1+deb13u1_amd64.deb"
  "pool/main/libatomic/libatomic1_14.2.0-19_amd64.deb"
  "pool/main/f/fontconfig/libfontconfig1_2.15.0-2.3_amd64.deb"
  "pool/main/f/fontconfig/fontconfig_2.15.0-2.3_amd64.deb"
  "pool/main/f/fonts-dejavu-core/fonts-dejavu-core_2.37-8_all.deb"
)

for f in "${files[@]}"; do
  out="$DEBS_DIR/$(basename "$f")"
  if [ ! -f "$out" ]; then
    python3 -c "import urllib.request, sys; urllib.request.urlretrieve(sys.argv[1], sys.argv[2])" "$BASE/$f" "$out"
  fi
  pkgname="$(basename "$f" .deb)"
  if [ ! -d "$LIBS_DIR/$pkgname" ]; then
    dpkg-deb -x "$out" "$LIBS_DIR/$pkgname" >/dev/null
  fi
  echo "extracted $pkgname"
done

# Stable symlink so fonts.conf can reference a fixed path regardless of the
# versioned directory name.
fontdir=$(ls -d "$LIBS_DIR"/fonts-dejavu-core_*/usr/share/fonts/truetype/dejavu 2>/dev/null | head -1 || true)
if [ -n "$fontdir" ]; then
  ln -sfn "$fontdir" "$LIBS_DIR/dejavu-fonts"
  # Regenerate fonts.conf (next to this script) with the absolute font path.
  conf="$(cd "$(dirname "$0")" && pwd)/fonts.conf"
  cat > "$conf" <<EOF
<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>$fontdir</dir>
  <cachedir>$LIBS_DIR/fc-cache</cachedir>
</fontconfig>
EOF
fi

echo "DONE. LIBS_DIR=$LIBS_DIR"
echo "export LD_LIBRARY_PATH=\$(ls -d \"$LIBS_DIR\"/*/usr/lib/x86_64-linux-gnu | tr '\\n' ':')"
echo "export FONTCONFIG_FILE=$(cd "$(dirname "$0")" && pwd)/fonts.conf"
