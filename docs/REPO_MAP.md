# Cloudflare Repository Map

## Primary Paths
- `fleet-worker/` — Cloudflare Worker project for fleet control plane
- `fleet-worker/src/index.js` — worker entrypoint
- `fleet-worker/migrations/` — D1 schema migrations
- `fleet-worker/sql/` — SQL helpers/seeds
- `fleet-worker/artifacts-v1/` — deployable UPS artifact bundle files
- `cloudflared-ups-pixhq.yml` — cloudflared ingress config
- `docs/handoff/` — cloudflare handoff and ops notes

## Quick Start
1. Read `docs/handoff/03-cloudflare-layer.md`
2. Review `fleet-worker/wrangler.toml`
3. Review `fleet-worker/src/index.js`
