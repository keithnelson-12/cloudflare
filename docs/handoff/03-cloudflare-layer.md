# 03 — Cloudflare Architecture & Management

## Mission
Provide secure, manageable remote connectivity and policy enforcement for UPS fleet access.

## Ownership Boundaries
- ✅ Tunnel architecture and connector lifecycle
- ✅ DNS and routing configuration
- ✅ Access/Zero Trust policy mapping
- ✅ API token usage model and blast-radius limits
- ✅ Cloudflare-side observability and incident response
- ❌ UPS monitor logic (UPS-Monitor)
- ❌ Base host hardening/firewall defaults (core)

## Architecture (fill-in)
- Cloudflare account / zones in scope:
- Tunnel topology:
- Connector deployment model:
- Traffic path summary:
- Failure domains:

## Management Model
- Provisioning:
- Rotation/revocation:
- Drift detection:
- Disaster recovery:

## Components Inventory
| Component | Path | Purpose | Owner |
|---|---|---|---|
| (example) tunnel deploy script | `scripts/tunnel-deploy.sh` | creates/updates tunnel | Cloudflare ops |

## Security Controls
- API token scopes and constraints:
- Access policies and groups:
- Audit/event logging:
- Allowed origins/network controls:

## Run / Validate
```bash
# TODO: replace with real commands
make plan
make apply
make verify
```

## Immediate Next Tasks
- [ ] Add exact tunnel + DNS config paths
- [ ] Document policy IDs/names (non-secret)
- [ ] Add rollback playbook for bad policy push
