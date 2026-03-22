#!/usr/bin/env bash
set -euo pipefail

# Upload local UPS artifacts to R2 under ups/<version>/...
# Usage:
#   ./upload-ups-artifacts.sh --version v1 --source /path/to/artifacts

VERSION=""
SRC=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --source) SRC="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 2 ;;
  esac
done

[[ -n "$VERSION" ]] || { echo "--version required"; exit 2; }
[[ -n "$SRC" ]] || { echo "--source required"; exit 2; }
[[ -d "$SRC" ]] || { echo "source dir not found: $SRC"; exit 2; }

REQ=(
  ups-epd.service
  waveshare-mini.tar.gz
  ups-epd.tar.gz
  nut.conf
  ups.conf
  upsd.users
  upsmon.conf
)

for f in "${REQ[@]}"; do
  [[ -f "$SRC/$f" ]] || { echo "missing required file: $SRC/$f"; exit 3; }
done

for f in "${REQ[@]}"; do
  key="ups/${VERSION}/${f}"
  echo "uploading $f -> $key"
  npx wrangler r2 object put "ups-artifacts/$key" --file "$SRC/$f"
done

echo "DONE version=$VERSION"
