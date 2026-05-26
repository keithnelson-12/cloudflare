-- Phase 1 of FLEET_SECRETS_ARCHITECTURE (see keithnelson-12/core docs/project/).
-- Adds tables the new /api/flash/* broker routes need:
--   device_tokens   — replaces hand-edited DEVICE_TOKENS_JSON worker secret
--   secrets_index   — metadata alongside R2 ciphertexts at secrets/<device_id>.age
--   audit           — both device + operator events, append-only

CREATE TABLE IF NOT EXISTS device_tokens (
  device_id   TEXT PRIMARY KEY,
  token       TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  revoked_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_device_tokens_revoked
  ON device_tokens(revoked_at);

CREATE TABLE IF NOT EXISTS secrets_index (
  device_id                      TEXT PRIMARY KEY,
  r2_key                         TEXT NOT NULL,
  content_sha256                 TEXT NOT NULL,
  recipients_fingerprints_json   TEXT,
  stored_at                      TEXT NOT NULL,
  superseded_at                  TEXT
);

CREATE INDEX IF NOT EXISTS idx_secrets_index_stored_at
  ON secrets_index(stored_at);

CREATE TABLE IF NOT EXISTS audit (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            TEXT NOT NULL,
  event_type    TEXT NOT NULL,
  device_id     TEXT,
  operator_id   TEXT,
  details_json  TEXT,
  source        TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_ts
  ON audit(ts);

CREATE INDEX IF NOT EXISTS idx_audit_device_type
  ON audit(device_id, event_type);

-- Extend devices table with hardware_code + revision provided at register-device time.
-- (The columns already exist in 0001_init.sql as nullable TEXT, so nothing to alter here —
-- Phase 1 just starts populating them instead of leaving them null.)
