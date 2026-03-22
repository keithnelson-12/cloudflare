export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const method = request.method.toUpperCase();

      if (!url.pathname.startsWith('/api/')) {
        return json({ ok: true, service: 'fleet-worker' });
      }

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

      if (method === 'GET' && url.pathname.startsWith('/api/artifacts/ups/')) {
        const ok = await requireGlobalBearer(request, env);
        if (!ok) return json({ error: 'unauthorized' }, 401);
        return await getUpsArtifact(url, env);
      }

      return json({ error: 'not_found' }, 404);
    } catch {
      return json({ error: 'server_error' }, 500);
    }
  }
};

function getBearer(req) {
  const auth = req.headers.get('authorization') || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : '';
}

async function requireGlobalBearer(req, env) {
  const expected = env.CENTRAL_TOKEN;
  if (!expected) return false;
  return getBearer(req) === expected;
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

async function requireDeviceBearer(req, env, deviceId) {
  const presented = getBearer(req);
  if (!presented) return false;

  const map = parseDeviceTokens(env);
  if (!map || !deviceId) return false;
  const expected = map[deviceId];
  if (typeof expected !== 'string' || expected.length === 0) return false;
  return presented === expected;
}

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

function limitText(value, maxLen = 8000) {
  if (typeof value !== 'string') return '';
  return value.length > maxLen ? value.slice(-maxLen) : value;
}

function contentTypeFor(name) {
  if (name.endsWith('.service') || name.endsWith('.conf') || name.endsWith('.users')) return 'text/plain; charset=utf-8';
  if (name.endsWith('.tar.gz')) return 'application/gzip';
  return 'application/octet-stream';
}
