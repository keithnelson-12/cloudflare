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
  # Installer scripts — pulled by the install-time flow so we don't need
  # to bake UPS-specific code into every SD card at flash time.
  ups-install-bundle.sh
  ups-install-status.sh
)

for f in "${REQ[@]}"; do
  [[ -f "$SRC/$f" ]] || { echo "missing required file: $SRC/$f"; exit 3; }
done

# Wrangler 4.x defaults `r2 object put` to the LOCAL Miniflare simulator
# unless --remote is passed. Silent trap: it prints "Upload complete" but
# nothing reaches the real bucket. Always pass --remote here.
# Also set CLOUDFLARE_ACCOUNT_ID to skip the /memberships preflight,
# which requires a User.Memberships scope that narrow R2 tokens don't have.
if [[ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
  echo "NOTE: CLOUDFLARE_ACCOUNT_ID not set — wrangler will try to resolve account"
  echo "      via /memberships and fail on R2-only API tokens. Export it first."
fi

for f in "${REQ[@]}"; do
  key="ups/${VERSION}/${f}"
  echo "uploading $f -> $key"
  npx wrangler r2 object put "ups-artifacts/$key" --file "$SRC/$f" --remote
done

echo "DONE version=$VERSION"
