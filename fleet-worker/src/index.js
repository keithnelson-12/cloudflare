export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const method = request.method.toUpperCase();

      if (!url.pathname.startsWith('/api/')) {
        return json({ ok: true, service: 'fleet-worker' });
      }

      // ───── Device-facing routes (per-device bearer auth) ─────
      if (method === 'GET' && url.pathname === '/api/device/desired-state') {
        return await getDesiredState(request, url, env);
      }
      if (method === 'POST' && url.pathname === '/api/device/command-ack') {
        return await postCommandAck(request, env);
      }
      if (method === 'POST' && url.pathname === '/api/device/command-result') {
        return await postCommandResult(request, env);
      }
      if (method === 'POST' && url.pathname === '/api/device/heartbeat') {
        return await postHeartbeat(request, env);
      }

      // ───── Artifact route (global bearer auth) ─────
      if (method === 'GET' && url.pathname.startsWith('/api/artifacts/ups/')) {
        const ok = await requireGlobalBearer(request, env);
        if (!ok) return json({ error: 'unauthorized' }, 401);
        return await getUpsArtifact(url, env);
      }

      // ───── Flash broker routes (station bearer auth; Phase 1 of
      //       FLEET_SECRETS_ARCHITECTURE). ─────
      if (method === 'POST' && url.pathname === '/api/flash/store-secrets') {
        return await postFlashStoreSecrets(request, env);
      }
      if (method === 'POST' && url.pathname === '/api/flash/create-tunnel') {
        return await postFlashCreateTunnel(request, env);
      }
      if (method === 'POST' && url.pathname === '/api/flash/register-device') {
        return await postFlashRegisterDevice(request, env);
      }
      if (method === 'POST' && url.pathname === '/api/flash/log') {
        return await postFlashLog(request, env);
      }

      return json({ error: 'not_found' }, 404);
    } catch {
      return json({ error: 'server_error' }, 500);
    }
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// Auth
// ═════════════════════════════════════════════════════════════════════════════

function getBearer(req) {
  const auth = req.headers.get('authorization') || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : '';
}

async function requireGlobalBearer(req, env) {
  const expected = env.CENTRAL_TOKEN;
  if (!expected) return false;
  return constantTimeEquals(getBearer(req), expected);
}

async function requireStationBearer(req, env) {
  const expected = env.STATION_TOKEN;
  if (!expected) return false;
  return constantTimeEquals(getBearer(req), expected);
}

function parseDeviceTokens(env) {
  const raw = env.DEVICE_TOKENS_JSON || '';
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Phase 1 change: check D1 `device_tokens` first, then fall back to the legacy
 * DEVICE_TOKENS_JSON worker secret. This lets new flashes self-register via
 * /api/flash/register-device while existing hand-registered devices keep
 * working until Phase 4 retires the env var.
 */
async function requireDeviceBearer(req, env, deviceId) {
  const presented = getBearer(req);
  if (!presented || !deviceId) return false;

  const row = await env.DB.prepare(
    `SELECT token, revoked_at FROM device_tokens WHERE device_id = ? LIMIT 1`
  ).bind(deviceId).first();
  if (row && !row.revoked_at && typeof row.token === 'string' && row.token.length > 0) {
    return constantTimeEquals(presented, row.token);
  }

  // Legacy fallback
  const map = parseDeviceTokens(env);
  if (!map) return false;
  const expected = map[deviceId];
  if (typeof expected !== 'string' || expected.length === 0) return false;
  return constantTimeEquals(presented, expected);
}

function constantTimeEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

// ═════════════════════════════════════════════════════════════════════════════
// Helpers
// ═════════════════════════════════════════════════════════════════════════════

function nowIso() {
  return new Date().toISOString();
}

function plusSecondsIso(sec) {
  return new Date(Date.now() + sec * 1000).toISOString();
}

function isIsoTimestamp(value) {
  if (typeof value !== 'string') return false;
  const d = new Date(value);
  return !Number.isNaN(d.getTime()) && d.toISOString() === value;
}

function isValidDeviceId(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 64
    && value.trim() === value
    && /^[A-Za-z0-9._:-]+$/.test(value);
}

function isValidActionId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(value);
}

function isValidHardwareCode(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 16 && /^[A-Z0-9]+$/.test(value);
}

function isValidRevision(value) {
  return typeof value === 'string' && /^[0-9]{2}$/.test(value);
}

function isValidToken(value) {
  return typeof value === 'string' && value.length >= 32 && value.length <= 512 && /^[A-Za-z0-9._:\-+/=]+$/.test(value);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    }
  });
}

async function parseJsonBody(request, maxBytes = 65536) {
  const contentType = (request.headers.get('content-type') || '').toLowerCase();
  const isJsonContentType = contentType.includes('application/json') || /application\/[^;]+\+json/.test(contentType);
  if (!isJsonContentType) {
    return { ok: false, response: json({ error: 'content_type_must_be_application_json' }, 415) };
  }

  const contentLength = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    return { ok: false, response: json({ error: 'payload_too_large', max_bytes: maxBytes }, 413) };
  }

  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).length > maxBytes) {
      return { ok: false, response: json({ error: 'payload_too_large', max_bytes: maxBytes }, 413) };
    }

    const body = JSON.parse(raw);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { ok: false, response: json({ error: 'invalid_json_body_shape', detail: 'expected JSON object' }, 400) };
    }
    return { ok: true, body };
  } catch {
    return { ok: false, response: json({ error: 'invalid_json' }, 400) };
  }
}

async function sha256Hex(input) {
  const buf = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function insertAudit(env, { event_type, device_id = null, operator_id = null, details = null, source = null }) {
  const details_json = details == null ? null : (typeof details === 'string' ? details : JSON.stringify(details));
  try {
    await env.DB.prepare(
      `INSERT INTO audit(ts, event_type, device_id, operator_id, details_json, source) VALUES(?, ?, ?, ?, ?, ?)`
    ).bind(nowIso(), event_type, device_id, operator_id, details_json, source).run();
  } catch {
    // Audit must never break the primary request path.
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Device-facing handlers (mostly unchanged from v1)
// ═════════════════════════════════════════════════════════════════════════════

async function upsertDevice(env, deviceId, statusJson = null) {
  const now = nowIso();
  const safeStatusJson = typeof statusJson === 'string' ? limitText(statusJson, 16000) : null;
  await env.DB.prepare(`
    INSERT INTO devices(device_id, created_at, updated_at, last_seen_at, status_json)
    VALUES(?, ?, ?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET
      updated_at=excluded.updated_at,
      last_seen_at=excluded.last_seen_at,
      status_json=COALESCE(excluded.status_json, devices.status_json)
  `).bind(deviceId, now, now, now, safeStatusJson).run();
}

async function getDesiredState(request, url, env) {
  const deviceId = url.searchParams.get('device_id');
  if (!deviceId) return json({ error: 'device_id_required' }, 400);
  if (!isValidDeviceId(deviceId)) {
    return json({ error: 'invalid_device_id', detail: 'device_id must be a non-empty trimmed string up to 64 chars' }, 400);
  }
  const okAuth = await requireDeviceBearer(request, env, deviceId);
  if (!okAuth) return json({ error: 'unauthorized' }, 401);

  await upsertDevice(env, deviceId, null);

  const now = nowIso();
  const row = await env.DB.prepare(`
    SELECT action_id, action_json
    FROM action_inbox
    WHERE device_id=?
      AND (
        status='queued'
        OR (status='leased' AND lease_until IS NOT NULL AND lease_until <= ?)
      )
      AND (expires_at IS NULL OR expires_at > ?)
    ORDER BY created_at ASC
    LIMIT 1
  `).bind(deviceId, now, now).first();

  if (!row) return json({ device_id: deviceId, actions: [] });

  const leaseSec = 120;
  const leaseUntil = plusSecondsIso(leaseSec);
  const leaseUpdate = await env.DB.prepare(`
    UPDATE action_inbox
    SET status='leased', lease_until=?, updated_at=?
    WHERE action_id=? AND device_id=?
      AND (
        status='queued'
        OR (status='leased' AND lease_until IS NOT NULL AND lease_until <= ?)
      )
      AND (expires_at IS NULL OR expires_at > ?)
  `).bind(leaseUntil, nowIso(), row.action_id, deviceId, now, now).run();

  if ((leaseUpdate.meta?.changes || 0) === 0) {
    return json({ device_id: deviceId, actions: [] });
  }

  let action;
  if (typeof row.action_json !== 'string') {
    action = { action_id: row.action_id, kind: 'invalid_payload_type' };
  } else if (row.action_json.length > 32768) {
    action = { action_id: row.action_id, kind: 'invalid_payload_too_large' };
  } else {
    try {
      action = JSON.parse(row.action_json);
    } catch {
      action = { action_id: row.action_id, kind: 'invalid' };
    }
  }

  if (!action || typeof action !== 'object' || Array.isArray(action)) {
    action = { action_id: row.action_id, kind: 'invalid_payload' };
  }

  if (String(action.kind || '').startsWith('invalid')) {
    await env.DB.prepare(`
      UPDATE action_inbox
      SET status='failed', lease_until=NULL, updated_at=?
      WHERE action_id=? AND device_id=?
    `).bind(nowIso(), row.action_id, deviceId).run();
    return json({ device_id: deviceId, actions: [] });
  }

  if (action.action_id !== row.action_id) {
    action.action_id = row.action_id;
  }

  return json({ device_id: deviceId, actions: [action] });
}

async function postCommandAck(request, env) {
  const parsed = await parseJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  const { device_id, action_id, started_at } = body;
  if (!device_id || !action_id) return json({ error: 'device_id_and_action_id_required' }, 400);
  if (!isValidDeviceId(device_id)) {
    return json({ error: 'invalid_device_id', detail: 'device_id must be a non-empty trimmed string up to 64 chars' }, 400);
  }
  if (!isValidActionId(action_id)) {
    return json({ error: 'invalid_action_id', detail: 'action_id must be a non-empty token up to 128 chars ([A-Za-z0-9._:-])' }, 400);
  }
  const okAuth = await requireDeviceBearer(request, env, device_id);
  if (!okAuth) return json({ error: 'unauthorized' }, 401);

  if (started_at != null && !isIsoTimestamp(started_at)) {
    return json({ error: 'invalid_started_at', detail: 'started_at must be ISO-8601 UTC timestamp' }, 400);
  }
  if (started_at != null) {
    const maxFutureSkewMs = 5 * 60 * 1000;
    if (new Date(started_at).getTime() > Date.now() + maxFutureSkewMs) {
      return json({ error: 'invalid_started_at', detail: 'started_at is too far in the future' }, 400);
    }
  }

  await upsertDevice(env, device_id, null);

  const now = nowIso();
  const ackUpdate = await env.DB.prepare(`
    UPDATE action_inbox
    SET status='running', lease_until=NULL, updated_at=?
    WHERE action_id=? AND device_id=? AND status IN ('queued','leased')
      AND (expires_at IS NULL OR expires_at > ?)
  `).bind(now, action_id, device_id, now).run();
  if ((ackUpdate.meta?.changes || 0) === 0) {
    return json({ error: 'unknown_action_id_for_device', detail: 'no queued/leased action matched action_id + device_id' }, 404);
  }

  return json({ ok: true, device_id, action_id, started_at: started_at || nowIso() });
}

async function postCommandResult(request, env) {
  const parsed = await parseJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  const {
    device_id, action_id, status, exit_code,
    stdout_tail, stderr_tail, duration_ms,
    started_at, finished_at
  } = body;

  if (!device_id || !action_id || !status) {
    return json({ error: 'device_id_action_id_status_required' }, 400);
  }
  if (!isValidDeviceId(device_id)) {
    return json({ error: 'invalid_device_id', detail: 'device_id must be a non-empty trimmed string up to 64 chars' }, 400);
  }
  if (!isValidActionId(action_id)) {
    return json({ error: 'invalid_action_id', detail: 'action_id must be a non-empty token up to 128 chars ([A-Za-z0-9._:-])' }, 400);
  }
  const okAuth = await requireDeviceBearer(request, env, device_id);
  if (!okAuth) return json({ error: 'unauthorized' }, 401);
  if (typeof status !== 'string') {
    return json({ error: 'invalid_status_type', detail: 'status must be a string' }, 400);
  }

  const normalizedStatus = status.trim().toLowerCase();
  const allowedResultStatuses = new Set(['succeeded', 'failed']);
  if (!allowedResultStatuses.has(normalizedStatus)) {
    return json({ error: 'invalid_status', allowed: ['succeeded', 'failed'] }, 400);
  }

  if (exit_code != null && (!Number.isInteger(exit_code) || exit_code < 0 || exit_code > 255)) {
    return json({ error: 'invalid_exit_code', detail: 'exit_code must be an integer between 0 and 255' }, 400);
  }

  if (duration_ms != null && (!Number.isInteger(duration_ms) || duration_ms < 0 || duration_ms > 604800000)) {
    return json({ error: 'invalid_duration_ms', detail: 'duration_ms must be an integer between 0 and 604800000 (7 days)' }, 400);
  }

  if (started_at != null && !isIsoTimestamp(started_at)) {
    return json({ error: 'invalid_started_at', detail: 'started_at must be ISO-8601 UTC timestamp' }, 400);
  }

  if (finished_at != null && !isIsoTimestamp(finished_at)) {
    return json({ error: 'invalid_finished_at', detail: 'finished_at must be ISO-8601 UTC timestamp' }, 400);
  }
  const nowMs = Date.now();
  const maxFutureSkewMs = 5 * 60 * 1000;
  if (started_at != null && new Date(started_at).getTime() > nowMs + maxFutureSkewMs) {
    return json({ error: 'invalid_started_at', detail: 'started_at is too far in the future' }, 400);
  }
  if (finished_at != null && new Date(finished_at).getTime() > nowMs + maxFutureSkewMs) {
    return json({ error: 'invalid_finished_at', detail: 'finished_at is too far in the future' }, 400);
  }
  if (started_at != null && finished_at != null && new Date(finished_at).getTime() < new Date(started_at).getTime()) {
    return json({ error: 'invalid_time_range', detail: 'finished_at must be greater than or equal to started_at' }, 400);
  }

  await upsertDevice(env, device_id, JSON.stringify({ last_result_status: normalizedStatus }));

  const inbox = await env.DB.prepare(`
    SELECT rollout_id, command_id FROM action_inbox WHERE action_id=? AND device_id=?
  `).bind(action_id, device_id).first();
  if (!inbox) {
    return json({ error: 'unknown_action_id_for_device', detail: 'action_id + device_id not found in action_inbox' }, 404);
  }

  const resultUpdate = await env.DB.prepare(`
    UPDATE action_inbox
    SET status=?, lease_until=NULL, updated_at=?
    WHERE action_id=? AND device_id=? AND status IN ('running','leased')
  `).bind(normalizedStatus, nowIso(), action_id, device_id).run();

  if ((resultUpdate.meta?.changes || 0) === 0) {
    return json({ error: 'invalid_action_state_for_result', detail: 'result accepted only for running/leased actions' }, 409);
  }

  const receivedAt = nowIso();
  const finishedAtValue = finished_at || receivedAt;

  await env.DB.prepare(`
    INSERT INTO action_results(
      action_id, device_id, rollout_id, command_id, status,
      exit_code, stdout_tail, stderr_tail, duration_ms,
      started_at, finished_at, received_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(action_id) DO UPDATE SET
      status=excluded.status,
      exit_code=excluded.exit_code,
      stdout_tail=excluded.stdout_tail,
      stderr_tail=excluded.stderr_tail,
      duration_ms=excluded.duration_ms,
      started_at=excluded.started_at,
      finished_at=excluded.finished_at,
      received_at=excluded.received_at
  `).bind(
    action_id, device_id, inbox?.rollout_id || null, inbox?.command_id || null,
    normalizedStatus, exit_code ?? null, limitText(stdout_tail), limitText(stderr_tail), duration_ms ?? null,
    started_at || null, finishedAtValue, receivedAt
  ).run();

  return json({ ok: true, action_id, status: normalizedStatus });
}

async function postHeartbeat(request, env) {
  const parsed = await parseJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  const deviceId = body.device_id;
  if (!deviceId) return json({ error: 'device_id_required' }, 400);
  if (!isValidDeviceId(deviceId)) {
    return json({ error: 'invalid_device_id', detail: 'device_id must be a non-empty trimmed string up to 64 chars' }, 400);
  }
  const okAuth = await requireDeviceBearer(request, env, deviceId);
  if (!okAuth) return json({ error: 'unauthorized' }, 401);

  let statusJson;
  try {
    statusJson = limitText(JSON.stringify(body), 16000);
  } catch {
    statusJson = JSON.stringify({ error: 'unserializable_heartbeat_payload' });
  }
  await upsertDevice(env, deviceId, statusJson);
  return json({ ok: true, device_id: deviceId, received_at: nowIso() });
}

async function getUpsArtifact(url, env) {
  const parts = url.pathname.split('/').filter(Boolean);
  // /api/artifacts/ups/:version/:file
  if (parts.length !== 5) return json({ error: 'bad_artifact_path' }, 400);

  const version = parts[3];
  const file = parts[4];

  if (!/^[a-zA-Z0-9._-]+$/.test(version) || !/^[a-zA-Z0-9._-]+$/.test(file)) {
    return json({ error: 'invalid_artifact_name' }, 400);
  }
  if (version.length > 64 || file.length > 128) {
    return json({ error: 'artifact_name_too_long' }, 400);
  }

  const key = `ups/${version}/${file}`;
  const obj = await env.ARTIFACTS.get(key);
  if (!obj) return json({ error: 'artifact_not_found', key }, 404);

  const headers = new Headers();
  headers.set('content-type', contentTypeFor(file));
  headers.set('cache-control', 'private, max-age=60');
  headers.set('vary', 'authorization');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('content-security-policy', "default-src 'none'");
  headers.set('content-disposition', `attachment; filename="${file}"`);

  return new Response(obj.body, { status: 200, headers });
}

// ═════════════════════════════════════════════════════════════════════════════
// Flash broker handlers (Phase 1 of FLEET_SECRETS_ARCHITECTURE)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * POST /api/flash/store-secrets
 * Body: { device_id, ciphertext, recipients_fingerprints?, force? }
 * Auth: Station bearer (STATION_TOKEN).
 *
 * Writes the age-encrypted per-device secret blob to R2 at
 * `secrets/<device_id>.age` and records metadata in the secrets_index table.
 * Rejects re-writes unless `force: true` (and marks the previous row
 * superseded when force is used).
 */
async function postFlashStoreSecrets(request, env) {
  if (!(await requireStationBearer(request, env))) {
    return json({ error: 'unauthorized' }, 401);
  }
  const parsed = await parseJsonBody(request, 1024 * 1024); // 1 MiB cap
  if (!parsed.ok) return parsed.response;
  const { device_id, ciphertext, recipients_fingerprints, force } = parsed.body;

  if (!isValidDeviceId(device_id)) {
    return json({ error: 'invalid_device_id' }, 400);
  }
  if (typeof ciphertext !== 'string' || ciphertext.length < 16 || ciphertext.length > 800000) {
    return json({ error: 'invalid_ciphertext', detail: 'expect ASCII-armored age, 16..800000 chars' }, 400);
  }
  if (recipients_fingerprints != null) {
    if (!Array.isArray(recipients_fingerprints) || recipients_fingerprints.length === 0 || recipients_fingerprints.length > 8) {
      return json({ error: 'invalid_recipients_fingerprints', detail: 'expect array of 1..8 strings' }, 400);
    }
    for (const fp of recipients_fingerprints) {
      if (typeof fp !== 'string' || fp.length < 8 || fp.length > 128) {
        return json({ error: 'invalid_recipients_fingerprints_item' }, 400);
      }
    }
  }

  const existing = await env.DB.prepare(
    `SELECT r2_key, content_sha256 FROM secrets_index WHERE device_id = ? AND superseded_at IS NULL LIMIT 1`
  ).bind(device_id).first();
  if (existing && !force) {
    return json({ error: 'secrets_already_stored', detail: 'pass force:true to overwrite', existing_sha256: existing.content_sha256 }, 409);
  }

  const r2_key = `secrets/${device_id}.age`;
  const content_sha256 = await sha256Hex(ciphertext);
  const stored_at = nowIso();

  await env.ARTIFACTS.put(r2_key, ciphertext, {
    httpMetadata: { contentType: 'application/x-age-encrypted' },
    customMetadata: { device_id, content_sha256, stored_at }
  });

  if (existing) {
    await env.DB.prepare(
      `UPDATE secrets_index SET superseded_at = ? WHERE device_id = ? AND superseded_at IS NULL`
    ).bind(stored_at, device_id).run();
  }

  await env.DB.prepare(
    `INSERT INTO secrets_index(device_id, r2_key, content_sha256, recipients_fingerprints_json, stored_at)
     VALUES(?, ?, ?, ?, ?)
     ON CONFLICT(device_id) DO UPDATE SET
       r2_key=excluded.r2_key,
       content_sha256=excluded.content_sha256,
       recipients_fingerprints_json=excluded.recipients_fingerprints_json,
       stored_at=excluded.stored_at,
       superseded_at=NULL`
  ).bind(
    device_id,
    r2_key,
    content_sha256,
    recipients_fingerprints ? JSON.stringify(recipients_fingerprints) : null,
    stored_at
  ).run();

  await insertAudit(env, {
    event_type: 'flash.store-secrets',
    device_id,
    details: { content_sha256, forced: !!force },
    source: 'kiosk'
  });

  return json({ ok: true, device_id, r2_key, content_sha256, stored_at });
}

/**
 * POST /api/flash/create-tunnel
 * Body: { device_id, cf_base_domain?, cf_web_service? }
 * Auth: Station bearer (STATION_TOKEN).
 *
 * Server-side equivalent of core/provision/image/create-device-tunnel.sh:
 * creates or reuses a named Cloudflare tunnel, applies ingress, creates DNS
 * CNAMEs for `<device_id>.<domain>` and `<device_id>-ssh.<domain>`,
 * returns the tunnel token for injection into /etc/ups-provision.env on the
 * flashed card.
 *
 * Uses env.CF_API_TOKEN_BROKER — a worker secret scoped to tunnel + DNS CRUD
 * for the tunnelremote.com zone. The station never holds this token.
 */
async function postFlashCreateTunnel(request, env) {
  if (!(await requireStationBearer(request, env))) {
    return json({ error: 'unauthorized' }, 401);
  }
  if (!env.CF_API_TOKEN_BROKER) {
    return json({ error: 'broker_misconfigured', detail: 'CF_API_TOKEN_BROKER secret not set' }, 500);
  }
  const parsed = await parseJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const { device_id } = parsed.body;
  const cf_base_domain = parsed.body.cf_base_domain || env.CF_BASE_DOMAIN || 'tunnelremote.com';
  const cf_web_service = parsed.body.cf_web_service || env.CF_WEB_SERVICE || 'http://localhost:5001';

  if (!isValidDeviceId(device_id)) {
    return json({ error: 'invalid_device_id' }, 400);
  }

  const cfHeaders = { 'Authorization': `Bearer ${env.CF_API_TOKEN_BROKER}`, 'Content-Type': 'application/json' };

  // Resolve zone + account
  const zoneResp = await fetch(
    `https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(cf_base_domain)}`,
    { headers: cfHeaders }
  );
  if (!zoneResp.ok) return json({ error: 'cf_zone_lookup_failed', status: zoneResp.status }, 502);
  const zoneJson = await zoneResp.json();
  const zone = (zoneJson.result || [])[0];
  if (!zone) return json({ error: 'cf_zone_not_found', domain: cf_base_domain }, 502);
  const zone_id = zone.id;
  const account_id = zone.account?.id;
  if (!zone_id || !account_id) return json({ error: 'cf_zone_or_account_missing' }, 502);

  // Create (or reuse) the tunnel
  let tunnel_id = null;
  const createResp = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account_id}/cfd_tunnel`,
    {
      method: 'POST',
      headers: cfHeaders,
      body: JSON.stringify({ name: device_id, config_src: 'cloudflare' })
    }
  );
  if (createResp.status === 409) {
    const listResp = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${account_id}/cfd_tunnel?name=${encodeURIComponent(device_id)}&is_deleted=false`,
      { headers: cfHeaders }
    );
    if (!listResp.ok) return json({ error: 'cf_tunnel_list_failed', status: listResp.status }, 502);
    const listJson = await listResp.json();
    tunnel_id = (listJson.result || [])[0]?.id || null;
  } else if (createResp.ok) {
    const createJson = await createResp.json();
    tunnel_id = createJson.result?.id || null;
  } else {
    return json({ error: 'cf_tunnel_create_failed', status: createResp.status }, 502);
  }
  if (!tunnel_id) return json({ error: 'cf_tunnel_id_missing' }, 502);

  // Fetch tunnel token
  const tokenResp = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account_id}/cfd_tunnel/${tunnel_id}/token`,
    { headers: cfHeaders }
  );
  if (!tokenResp.ok) return json({ error: 'cf_tunnel_token_failed', status: tokenResp.status }, 502);
  const tokenJson = await tokenResp.json();
  const tunnel_token = typeof tokenJson.result === 'string' ? tokenJson.result : (tokenJson.result?.token || '');
  if (!tunnel_token) return json({ error: 'cf_tunnel_token_missing' }, 502);

  // Apply ingress config
  const host = `${device_id}.${cf_base_domain}`;
  const ssh_host = `${device_id}-ssh.${cf_base_domain}`;
  const ingressResp = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account_id}/cfd_tunnel/${tunnel_id}/configurations`,
    {
      method: 'PUT',
      headers: cfHeaders,
      body: JSON.stringify({
        config: {
          ingress: [
            { hostname: host, service: cf_web_service },
            { hostname: ssh_host, service: 'ssh://localhost:22' },
            { service: 'http_status:404' }
          ],
          'warp-routing': { enabled: false }
        }
      })
    }
  );
  if (!ingressResp.ok) return json({ error: 'cf_ingress_apply_failed', status: ingressResp.status }, 502);

  // Create DNS CNAMEs (idempotent via try+ignore on 400-class if record exists)
  for (const name of [host, ssh_host]) {
    await fetch(
      `https://api.cloudflare.com/client/v4/zones/${zone_id}/dns_records`,
      {
        method: 'POST',
        headers: cfHeaders,
        body: JSON.stringify({
          type: 'CNAME',
          name,
          content: `${tunnel_id}.cfargotunnel.com`,
          proxied: true
        })
      }
    ).catch(() => { /* tolerate; idempotent flashes hit "already exists" */ });
  }

  await insertAudit(env, {
    event_type: 'flash.create-tunnel',
    device_id,
    details: { tunnel_id, host, ssh_host },
    source: 'kiosk'
  });

  return json({ ok: true, device_id, tunnel_id, tunnel_token, host, ssh_host });
}

/**
 * POST /api/flash/register-device
 * Body: { device_id, hardware_code, revision, device_token, flashed_by?, tags? }
 * Auth: Station bearer (STATION_TOKEN).
 *
 * Registers the device in D1 devices + device_tokens so that subsequent
 * /api/device/heartbeat and /api/device/desired-state calls will authenticate
 * without any edit to the DEVICE_TOKENS_JSON worker secret.
 */
async function postFlashRegisterDevice(request, env) {
  if (!(await requireStationBearer(request, env))) {
    return json({ error: 'unauthorized' }, 401);
  }
  const parsed = await parseJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const { device_id, hardware_code, revision, device_token, flashed_by, tags } = parsed.body;

  if (!isValidDeviceId(device_id)) {
    return json({ error: 'invalid_device_id' }, 400);
  }
  if (!isValidHardwareCode(hardware_code)) {
    return json({ error: 'invalid_hardware_code' }, 400);
  }
  if (!isValidRevision(revision)) {
    return json({ error: 'invalid_revision', detail: 'expect 2-digit string like "01"' }, 400);
  }
  if (!isValidToken(device_token)) {
    return json({ error: 'invalid_device_token', detail: 'expect 32..512 chars, alnum + safe symbols' }, 400);
  }
  if (flashed_by != null && (typeof flashed_by !== 'string' || flashed_by.length > 128)) {
    return json({ error: 'invalid_flashed_by' }, 400);
  }
  let tags_json = null;
  if (tags != null) {
    if (typeof tags !== 'object' || Array.isArray(tags)) {
      return json({ error: 'invalid_tags', detail: 'expect object' }, 400);
    }
    try { tags_json = JSON.stringify(tags); } catch { return json({ error: 'tags_unserializable' }, 400); }
    if (tags_json.length > 8000) return json({ error: 'tags_too_large' }, 413);
  }

  const now = nowIso();

  // Upsert device record with hardware metadata
  await env.DB.prepare(`
    INSERT INTO devices(device_id, product, hardware_code, revision, tags_json, created_at, updated_at)
    VALUES(?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET
      hardware_code=excluded.hardware_code,
      revision=excluded.revision,
      tags_json=COALESCE(excluded.tags_json, devices.tags_json),
      updated_at=excluded.updated_at
  `).bind(device_id, null, hardware_code, revision, tags_json, now, now).run();

  // Upsert token (unrevokes any prior revocation)
  await env.DB.prepare(`
    INSERT INTO device_tokens(device_id, token, created_at, revoked_at)
    VALUES(?, ?, ?, NULL)
    ON CONFLICT(device_id) DO UPDATE SET
      token=excluded.token,
      created_at=excluded.created_at,
      revoked_at=NULL
  `).bind(device_id, device_token, now).run();

  await insertAudit(env, {
    event_type: 'flash.register-device',
    device_id,
    operator_id: flashed_by || null,
    details: { hardware_code, revision, tags_json },
    source: 'kiosk'
  });

  return json({ ok: true, device_id, registered_at: now });
}

/**
 * POST /api/flash/log
 * Body: { event_type, device_id?, operator_id?, details? }
 * Auth: Station bearer (STATION_TOKEN).
 *
 * Mirror of the station's local audit log. Fire-and-forget; always 200 as
 * long as the shape is valid.
 */
async function postFlashLog(request, env) {
  if (!(await requireStationBearer(request, env))) {
    return json({ error: 'unauthorized' }, 401);
  }
  const parsed = await parseJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const { event_type, device_id, operator_id, details } = parsed.body;

  if (typeof event_type !== 'string' || event_type.length === 0 || event_type.length > 64) {
    return json({ error: 'invalid_event_type' }, 400);
  }
  if (device_id != null && !isValidDeviceId(device_id)) {
    return json({ error: 'invalid_device_id' }, 400);
  }
  if (operator_id != null && (typeof operator_id !== 'string' || operator_id.length > 128)) {
    return json({ error: 'invalid_operator_id' }, 400);
  }

  await insertAudit(env, {
    event_type,
    device_id: device_id || null,
    operator_id: operator_id || null,
    details: details ?? null,
    source: 'kiosk'
  });

  return json({ ok: true });
}

// ═════════════════════════════════════════════════════════════════════════════
// Misc
// ═════════════════════════════════════════════════════════════════════════════

function limitText(value, maxLen = 8000) {
  if (typeof value !== 'string') return '';
  return value.length > maxLen ? value.slice(-maxLen) : value;
}

function contentTypeFor(name) {
  if (name.endsWith('.service') || name.endsWith('.conf') || name.endsWith('.users')) return 'text/plain; charset=utf-8';
  if (name.endsWith('.tar.gz')) return 'application/gzip';
  return 'application/octet-stream';
}
