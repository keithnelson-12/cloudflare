# fleet-worker (Cloudflare Worker + D1)

Minimal v1 control plane for device polling + command ack/result.

## 1) Prereqs

- Cloudflare account + Wrangler logged in
- D1 database created (example name: `fleet-control`)

## 2) Configure

1. Edit `wrangler.toml` and set `database_id`.
2. Set bearer token secret:

```bash
wrangler secret put CENTRAL_TOKEN
```

## 3) Install + deploy

```bash
npm install
npm run deploy
```

## 4) Apply migration

```bash
npm run d1:migrate
```

## 5) Device endpoint config

Set these on device (`/etc/ups-provision.env`):

- `CENTRAL_CONFIG_URL=https://<worker-domain>/api/device/desired-state`
- `CENTRAL_ACK_URL=https://<worker-domain>/api/device/command-ack`
- `CENTRAL_RESULT_URL=https://<worker-domain>/api/device/command-result`
- `CENTRAL_STATUS_URL=https://<worker-domain>/api/device/heartbeat`
- `CENTRAL_TOKEN=<same as worker secret>`

## 5.1 UPS artifact hosting (R2 private via Worker)

Worker route:
- `GET /api/artifacts/ups/:version/:file`
- Protected by same Bearer token (`CENTRAL_TOKEN`)

Expected R2 keys:
- `ups/<version>/ups-epd.service`
- `ups/<version>/waveshare-mini.tar.gz`
- `ups/<version>/ups-epd.tar.gz`
- `ups/<version>/nut.conf`
- `ups/<version>/ups.conf`
- `ups/<version>/upsd.users`
- `ups/<version>/upsmon.conf`

Upload helper:

```bash
./upload-ups-artifacts.sh --version v1 --source /path/to/ups-artifacts
```

## 6) Seed a canary command

Example SQL (D1):

```sql
INSERT INTO action_inbox(
  action_id, device_id, rollout_id, command_id, action_json,
  status, lease_until, expires_at, created_at, updated_at
) VALUES (
  'canary-002',
  'UPS-001-01-RON59PKHJFAC',
  NULL,
  'cmd-canary-uname',
  '{"action_id":"canary-002","kind":"run_command","command":{"payload":{"script":"uname -a"},"constraints":{"timeout_sec":30,"idempotency_key":"canary-002"}}}',
  'queued', NULL, NULL, datetime('now'), datetime('now')
);
```

Then trigger device poll (`desired-state.sh`) and inspect `action_results`.

## 7) Current limitations

- No rollout phase engine yet (single-action queue only)
- No signature verification yet
- Basic auth = one shared bearer token
