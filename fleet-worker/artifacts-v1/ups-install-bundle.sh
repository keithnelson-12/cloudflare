#!/usr/bin/env bash
set -euo pipefail

# UPS install bundle v1
# Installs UPS drivers/tools + app payload from central artifact URLs.

ENV_FILE="/etc/fleet-provision.env"
[[ -f "$ENV_FILE" ]] && source "$ENV_FILE"

STATE_DIR="${STATE_DIR:-/var/lib/fleet-provision}"
UPS_STATE_DIR="$STATE_DIR/ups-install"
mkdir -p "$UPS_STATE_DIR"

ARTIFACT_BASE_URL="${UPS_ARTIFACT_BASE_URL:-}"
UPS_BUNDLE_VERSION="${UPS_BUNDLE_VERSION:-latest}"
WORK=/var/tmp/ups-install
mkdir -p "$WORK"

START_EPOCH="$(date +%s)"
START_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo "$START_TS" > "$UPS_STATE_DIR/start_ts"

log() { echo "[ups-install] $*"; }
fail() {
  local code="$1" msg="$2"
  local end_epoch end_ts duration_sec
  end_epoch="$(date +%s)"
  end_ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  duration_sec="$(( end_epoch - START_EPOCH ))"
  echo "$end_ts" > "$UPS_STATE_DIR/end_ts"
  echo "$duration_sec" > "$UPS_STATE_DIR/duration_sec"
  echo "$code" > "$UPS_STATE_DIR/exit_code"
  echo "$msg" > "$UPS_STATE_DIR/error"
  echo "FAIL" > "$UPS_STATE_DIR/status"
  log "ERROR=$msg CODE=$code DURATION_SEC=$duration_sec"
  exit "$code"
}

if [[ -z "$ARTIFACT_BASE_URL" ]]; then
  fail 60 "UPS_ARTIFACT_BASE_URL_MISSING"
fi

echo "RUNNING" > "$UPS_STATE_DIR/status"

# Wait for apt/dpkg lock if needed
for i in $(seq 1 24); do
  if ! fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 && ! fuser /var/lib/apt/lists/lock >/dev/null 2>&1; then
    break
  fi
  log "waiting for apt lock ($i/24)"
  sleep 5
done

PACKAGES=(nut nut-server nut-client python3-gpiozero python3-spidev python3-pil python3-numpy fonts-dejavu-core)

log "installing apt packages"
apt-get update -y || fail 61 "APT_UPDATE_FAILED"
DEBIAN_FRONTEND=noninteractive apt-get install -y "${PACKAGES[@]}" || fail 62 "APT_INSTALL_FAILED"

log "downloading bundle artifacts"
CURL_AUTH=()
if [[ -n "${CENTRAL_TOKEN:-}" ]]; then
  CURL_AUTH=(-H "Authorization: Bearer ${CENTRAL_TOKEN}")
fi

download_artifact() {
  local f="$1" url="$ARTIFACT_BASE_URL/$UPS_BUNDLE_VERSION/$f"
  local attempt
  for attempt in 1 2 3; do
    if curl -fsSL --connect-timeout 10 --max-time 120 --retry 2 --retry-delay 2 --retry-all-errors "${CURL_AUTH[@]}" "$url" -o "$WORK/$f"; then
      return 0
    fi
    log "download retry $attempt/3 failed for $f"
    sleep 2
  done
  fail 63 "ARTIFACT_DOWNLOAD_FAILED:$f"
}

for f in ups-epd.service waveshare-mini.tar.gz ups-epd.tar.gz nut.conf ups.conf upsd.users upsmon.conf; do
  download_artifact "$f"
done

log "installing files"
install -d /opt/waveshare-mini /opt/ups-epd /etc/nut || fail 64 "INSTALL_DIR_FAILED"
install -m 644 "$WORK/ups-epd.service" /etc/systemd/system/ups-epd.service || fail 65 "INSTALL_SERVICE_FAILED"

tar -xzf "$WORK/waveshare-mini.tar.gz" -C /opt/waveshare-mini --strip-components=1 || fail 66 "WAVESHARE_EXTRACT_FAILED"
tar -xzf "$WORK/ups-epd.tar.gz" -C /opt/ups-epd --strip-components=1 || fail 67 "UPS_EPD_EXTRACT_FAILED"

install -m 644 "$WORK/nut.conf" /etc/nut/nut.conf || fail 68 "NUT_CONF_INSTALL_FAILED"
install -m 644 "$WORK/ups.conf" /etc/nut/ups.conf || fail 69 "UPS_CONF_INSTALL_FAILED"
install -m 640 "$WORK/upsd.users" /etc/nut/upsd.users || fail 70 "UPSD_USERS_INSTALL_FAILED"
install -m 640 "$WORK/upsmon.conf" /etc/nut/upsmon.conf || fail 71 "UPSMON_CONF_INSTALL_FAILED"
chown root:nut /etc/nut/upsd.users /etc/nut/upsmon.conf || true

ensure_spi_enabled() {
  local boot_cfg=""
  if [[ -f /boot/firmware/config.txt ]]; then
    boot_cfg=/boot/firmware/config.txt
  elif [[ -f /boot/config.txt ]]; then
    boot_cfg=/boot/config.txt
  fi

  if [[ -z "$boot_cfg" ]]; then
    log "WARN no boot config found; skipping SPI config"
    return 0
  fi

  grep -q '^dtparam=spi=on$' "$boot_cfg" || echo 'dtparam=spi=on' >> "$boot_cfg"

  # Best-effort immediate activation (may still require reboot depending on platform/firmware).
  modprobe spi_bcm2835 >/dev/null 2>&1 || true
  modprobe spidev >/dev/null 2>&1 || true

  if [[ ! -e /dev/spidev0.0 ]]; then
    log "WARN /dev/spidev0.0 not present yet; SPI config applied and will be effective after reboot"
  fi
}

log "ensuring SPI enabled for waveshare display"
ensure_spi_enabled

log "enabling/restarting services"
systemctl daemon-reload || fail 72 "DAEMON_RELOAD_FAILED"
systemctl enable nut-server nut-monitor ups-epd || fail 73 "ENABLE_SERVICES_FAILED"
systemctl restart nut-server nut-monitor ups-epd || fail 74 "RESTART_SERVICES_FAILED"

# services (especially ups-epd) may need warm-up time; wait with bounded retries
WAIT_SEC="${UPS_SERVICE_HEALTH_WAIT_SEC:-90}"
SLEEP_SEC=3
elapsed=0
while true; do
  ns=$(systemctl is-active nut-server 2>/dev/null || true)
  nm=$(systemctl is-active nut-monitor 2>/dev/null || true)
  ue=$(systemctl is-active ups-epd 2>/dev/null || true)

  if [[ "$ns" == "active" && "$nm" == "active" && "$ue" == "active" ]]; then
    break
  fi

  if (( elapsed >= WAIT_SEC )); then
    break
  fi

  sleep "$SLEEP_SEC"
  elapsed=$((elapsed + SLEEP_SEC))
done

if [[ "$ns" != "active" || "$nm" != "active" || "$ue" != "active" ]]; then
  # capture diagnostics for remote triage
  systemctl status nut-server --no-pager > "$UPS_STATE_DIR/nut-server.status.txt" 2>&1 || true
  systemctl status nut-monitor --no-pager > "$UPS_STATE_DIR/nut-monitor.status.txt" 2>&1 || true
  systemctl status ups-epd --no-pager > "$UPS_STATE_DIR/ups-epd.status.txt" 2>&1 || true
  journalctl -u ups-epd -n 120 --no-pager > "$UPS_STATE_DIR/ups-epd.journal.txt" 2>&1 || true
  fail 75 "SERVICE_HEALTH_FAILED:nut-server=$ns nut-monitor=$nm ups-epd=$ue waited=${elapsed}s"
fi

end_epoch="$(date +%s)"
end_ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
duration_sec="$(( end_epoch - START_EPOCH ))"

echo "$UPS_BUNDLE_VERSION" > "$UPS_STATE_DIR/version"
echo "$end_ts" > "$UPS_STATE_DIR/end_ts"
echo "$duration_sec" > "$UPS_STATE_DIR/duration_sec"
echo "0" > "$UPS_STATE_DIR/exit_code"
echo "" > "$UPS_STATE_DIR/error"
echo "DONE" > "$UPS_STATE_DIR/status"

# Register product services so the generic device-heartbeat picks them up
PRODUCT_SERVICES_FILE="$STATE_DIR/product-services.list"
for svc in nut-server nut-monitor ups-epd; do
  grep -qxF "$svc" "$PRODUCT_SERVICES_FILE" 2>/dev/null || echo "$svc" >> "$PRODUCT_SERVICES_FILE"
done
log "complete version=$UPS_BUNDLE_VERSION DURATION_SEC=$duration_sec"

# Reboot to activate dtparam=spi=on — without it, ups-epd crashloops on
# /dev/spidev0.0 missing. Callers that batch multiple installs before a
# single reboot can set UPS_INSTALL_SKIP_REBOOT=1.
if [[ "${UPS_INSTALL_SKIP_REBOOT:-0}" != "1" ]]; then
  log "scheduling reboot in 5s to activate SPI kernel module"
  systemd-run --on-active=5 /sbin/reboot >/dev/null 2>&1 \
    || nohup bash -c 'sleep 5 && /sbin/reboot' >/dev/null 2>&1 &
fi
