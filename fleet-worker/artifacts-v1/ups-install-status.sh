#!/usr/bin/env bash
set -euo pipefail

STATE_DIR="${STATE_DIR:-/var/lib/fleet-provision}"
UPS_STATE_DIR="$STATE_DIR/ups-install"

readf() {
  local f="$1"
  [[ -f "$UPS_STATE_DIR/$f" ]] && cat "$UPS_STATE_DIR/$f" || true
}

status="$(readf status)"
version="$(readf version)"
exit_code="$(readf exit_code)"
error="$(readf error)"
start_ts="$(readf start_ts)"
end_ts="$(readf end_ts)"
duration_sec="$(readf duration_sec)"

if [[ -z "$status" && -z "$start_ts" ]]; then
  echo "UPS_INSTALL_STATE=MISSING"
  echo "UPS_INSTALL_DIR=$UPS_STATE_DIR"
  exit 2
fi

echo "UPS_INSTALL_STATE=${status:-UNKNOWN}"
echo "UPS_INSTALL_VERSION=${version:-}"
echo "UPS_INSTALL_EXIT_CODE=${exit_code:-}"
echo "UPS_INSTALL_DURATION_SEC=${duration_sec:-}"
echo "UPS_INSTALL_START_TS=${start_ts:-}"
echo "UPS_INSTALL_END_TS=${end_ts:-}"
if [[ -n "$error" ]]; then
  echo "UPS_INSTALL_ERROR=$error"
fi
