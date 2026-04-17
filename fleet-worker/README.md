# fleet-worker (Cloudflare Worker + D1 + R2)

Control plane for the Pi fleet. Serves three classes of routes:

1. **Device-facing** — per-device bearer auth; heartbeat, desired-state poll, command ack/result.
2. **Artifact delivery** — global bearer auth; Worker-proxied R2 downloads for UPS install bundles.
3. **Flash broker** — station bearer auth; Phase 1 of [`FLEET_SECRETS_ARCHITECTURE.md`](https://github.com/keithnelson-12/core/blob/main/docs/project/FLEET_SECRETS_ARCHITECTURE.md) in the core repo. Lets a flash station create tunnels, store per-device secret ciphertexts, and register devices without ever holding the real CF API token or hand-editing worker secrets.

## Prereqs

- Cloudflare account + Wrangler logged in (`wrangler login`)
- D1 database `fleet-control` (create once via `setup-cloudflare.sh`)
- R2 bucket `ups-artifacts` (Phase 1 stores both `ups/<version>/*` artifact
  files and `secrets/<device_id>.age` per-device ciphertexts in this bucket)
- A scoped CF API token with tunnel + DNS CRUD on the `tunnelremote.com`
  zone — used only by the Worker broker, not by deploy-01 or the kiosk.

## Configure

Edit `wrangler.toml` if you need to override `CF_BASE_DOMAIN` or
`CF_WEB_SERVICE`. Then set worker secrets:

```bash
wrangler secret put CENTRAL_TOKEN          # global bearer for /api/artifacts/ups/*
wrangler secret put STATION_TOKEN          # bearer the flash station will present
wrangler secret put CF_API_TOKEN_BROKER    # scoped CF API token (tunnel + DNS on tunnelremote.com)
# DEVICE_TOKENS_JSON remains optional — legacy per-device auth map; new devices register in D1.
```

## Deploy

```bash
npm install
wrangler d1 migrations apply fleet-control   # applies 0001_init.sql then 0002_add_flash_broker.sql
wrangler deploy
```

## Upload v1 UPS artifacts to R2

The 7 required files are in `artifacts-v1/` in the repo. Upload once:

```bash
./upload-ups-artifacts.sh --version v1 --source ./artifacts-v1
```

Validates:
```bash
curl -fsS -H "Authorization: Bearer $CENTRAL_TOKEN" \
  https://fleet-api.tunnelremote.com/api/artifacts/ups/v1/ups-epd.service | head
```

## Routes

### Device-facing
Auth: `Authorization: Bearer <device_token>`. Token lookup checks the D1
`device_tokens` table first, then falls back to the legacy
`DEVICE_TOKENS_JSON` worker secret if the device isn't registered yet.

- `GET  /api/device/desired-state?device_id=...`
- `POST /api/device/command-ack`
- `POST /api/device/command-result`
- `POST /api/device/heartbeat`

Device-side env contract:
```
CENTRAL_CONFIG_URL=https://fleet-api.tunnelremote.com/api/device/desired-state
CENTRAL_ACK_URL=https://fleet-api.tunnelremote.com/api/device/command-ack
CENTRAL_RESULT_URL=https://fleet-api.tunnelremote.com/api/device/command-result
CENTRAL_STATUS_URL=https://fleet-api.tunnelremote.com/api/device/heartbeat
DEVICE_TOKEN=<per-device 64-hex token, matched in device_tokens table>
```

### Artifact delivery
Auth: `Authorization: Bearer <CENTRAL_TOKEN>`.

- `GET /api/artifacts/ups/:version/:file` — streams the R2 object at `ups/<version>/<file>`.

### Flash broker
Auth: `Authorization: Bearer <STATION_TOKEN>`.

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/api/flash/store-secrets` | `{device_id, ciphertext, recipients_fingerprints?, force?}` | `{ok, r2_key, content_sha256, stored_at}` |
| POST | `/api/flash/create-tunnel` | `{device_id, cf_base_domain?, cf_web_service?}` | `{ok, tunnel_id, tunnel_token, host, ssh_host}` |
| POST | `/api/flash/register-device` | `{device_id, hardware_code, revision, device_token, flashed_by?, tags?}` | `{ok, registered_at}` |
| POST | `/api/flash/log` | `{event_type, device_id?, operator_id?, details?}` | `{ok}` |

**`store-secrets`** stores an ASCII-armored age ciphertext in R2 at
`secrets/<device_id>.age` and records its SHA-256 + recipient fingerprints
in `secrets_index`. Re-writes rejected with HTTP 409 unless `force:true`.

**`create-tunnel`** is the Worker-side equivalent of
`core/provision/image/create-device-tunnel.sh`: creates (or reuses, if
409) a named Cloudflare tunnel, applies ingress for `<device_id>.<domain>`
and `<device_id>-ssh.<domain>`, creates the two DNS CNAMEs, and returns
the tunnel token to inject into the device's `/etc/ups-provision.env`.

**`register-device`** inserts or updates a row in `devices` with hardware
metadata and upserts the per-device token in `device_tokens`. After this,
the device's heartbeat / desired-state calls will authenticate without
any hand-edit of `DEVICE_TOKENS_JSON`.

**`log`** is the kiosk's remote-audit mirror. Async; never blocks the
station's flash flow.

## Smoke tests (post-deploy)

```bash
STATION_TOKEN=...   # as set on the worker

# Health probe
curl -fsS https://fleet-api.tunnelremote.com/api/nope   # expect {"ok":true,"service":"fleet-worker"}

# Unauthorized flash call
curl -i -X POST https://fleet-api.tunnelremote.com/api/flash/log \
  -H 'content-type: application/json' \
  -d '{"event_type":"test"}'      # expect 401

# Authorized no-op log
curl -fsS -X POST https://fleet-api.tunnelremote.com/api/flash/log \
  -H "authorization: Bearer $STATION_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"event_type":"smoke-test"}' # expect {"ok":true}
```

## Schema

Tables (D1):

- `devices` — id, product, hardware_code, revision, tags_json, status, timestamps
- `device_tokens` — device_id → token (Phase 1); supersedes hand-edited `DEVICE_TOKENS_JSON`
- `secrets_index` — device_id → r2_key + sha256 + recipient fingerprints
- `audit` — append-only event log (flash events + device events)
- `action_inbox` / `action_results` — per-device command queue + results

Migrations:

- `0001_init.sql` — initial schema (devices, action_inbox, action_results)
- `0002_add_flash_broker.sql` — Phase 1 additions (device_tokens, secrets_index, audit)

## Current limitations

- No rollout phase engine (single-action queue only). See `CLOUD_PUSH_ROADMAP.md` Phase 5.
- No command signature verification yet.
- Flash broker uses a shared `STATION_TOKEN` (one station). Phase 2 of the
  secrets architecture replaces this with Cloudflare Access service-token
  validation, giving per-station identity + revocation.
- `BOOTSTRAP_URL` endpoint not yet implemented. See `CLOUD_PUSH_ROADMAP.md`
  Phase 2.
