-- Replace DEVICE_ID and bundle values as needed
INSERT OR REPLACE INTO action_inbox(
  action_id, device_id, rollout_id, command_id, action_json,
  status, lease_until, expires_at, created_at, updated_at
) VALUES (
  'ups-install-001',
  'UPS-001-01-RON59PKHJFAC',
  NULL,
  'cmd-ups-install-v1',
  '{"action_id":"ups-install-001","kind":"run_command","command":{"payload":{"script":"sudo /opt/ups-provision/lib/ups-install-bundle.sh"},"constraints":{"timeout_sec":900,"idempotency_key":"ups-install-UPS-001-01-RON59PKHJFAC-v1"}}}',
  'queued', NULL, NULL, datetime('now'), datetime('now')
);
