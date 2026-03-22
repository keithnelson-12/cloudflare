CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY,
  product TEXT,
  hardware_code TEXT,
  revision TEXT,
  tags_json TEXT,
  last_seen_at TEXT,
  status_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS action_inbox (
  action_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  rollout_id TEXT,
  command_id TEXT,
  action_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  lease_until TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS action_results (
  action_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  rollout_id TEXT,
  command_id TEXT,
  status TEXT NOT NULL,
  exit_code INTEGER,
  stdout_tail TEXT,
  stderr_tail TEXT,
  duration_ms INTEGER,
  started_at TEXT,
  finished_at TEXT,
  received_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_inbox_device_status ON action_inbox(device_id, status);
CREATE INDEX IF NOT EXISTS idx_devices_last_seen ON devices(last_seen_at);
