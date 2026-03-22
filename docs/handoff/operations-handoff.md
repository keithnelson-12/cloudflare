# Cloudflare Operations Notes

## Pre-Change Checklist
- [ ] Token scope is least-privilege
- [ ] Planned DNS/tunnel changes documented
- [ ] Rollback command ready
- [ ] Blast radius assessed

## Post-Change Validation
- [ ] Tunnel healthy
- [ ] Expected routes resolving
- [ ] Access policy behavior verified
- [ ] UPS endpoints reachable as intended

## Incident Triage
1. Check Cloudflare tunnel/connector status
2. Validate DNS records and propagation
3. Verify access policy evaluation logs
4. Roll back last known-good policy if needed
