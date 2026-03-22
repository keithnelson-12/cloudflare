#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if ! npx wrangler whoami >/dev/null 2>&1; then
  echo "NOT_AUTHENTICATED"
  echo "Run: npx wrangler login"
  exit 2
fi

DB_NAME="fleet-control"

echo "Creating or checking D1 database: $DB_NAME"
OUT=$(npx wrangler d1 create "$DB_NAME" 2>&1 || true)
if echo "$OUT" | grep -qi "already exists"; then
  echo "D1_EXISTS"
  DB_ID=$(npx wrangler d1 list --json | python3 - <<'PY'
import json,sys
items=json.load(sys.stdin)
for x in items:
    if x.get('name')=='fleet-control':
        print(x.get('uuid',''))
        break
PY
)
else
  DB_ID=$(printf '%s' "$OUT" | sed -n 's/.*database_id = "\([^"]*\)".*/\1/p' | head -n1)
fi

if [[ -z "${DB_ID:-}" ]]; then
  echo "FAILED_TO_RESOLVE_DB_ID"
  echo "$OUT"
  exit 3
fi

echo "Using DB_ID=$DB_ID"

python3 - <<PY
from pathlib import Path
p=Path('wrangler.toml')
s=p.read_text()
s=s.replace('database_id = "REPLACE_WITH_D1_DATABASE_ID"', f'database_id = "{DB_ID}"')
p.write_text(s)
print('UPDATED_WRANGLER_TOML')
PY

TOKEN_FILE="../.secrets/fleet-central-token.txt"
mkdir -p ../.secrets
if [[ ! -f "$TOKEN_FILE" ]]; then
  openssl rand -hex 32 > "$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE"
  echo "CREATED_TOKEN_FILE=$TOKEN_FILE"
fi

CENTRAL_TOKEN=$(cat "$TOKEN_FILE")
printf '%s' "$CENTRAL_TOKEN" | npx wrangler secret put CENTRAL_TOKEN >/dev/null

echo "APPLYING_MIGRATIONS"
npx wrangler d1 migrations apply "$DB_NAME"

echo "DEPLOYING_WORKER"
DEPLOY_OUT=$(npx wrangler deploy)
echo "$DEPLOY_OUT"

WORKER_URL=$(printf '%s' "$DEPLOY_OUT" | sed -n 's/.*https:\/\/\([^ ]*workers.dev\).*/https:\/\/\1/p' | head -n1)

echo "WORKER_URL=$WORKER_URL"
echo "CENTRAL_TOKEN_FILE=$TOKEN_FILE"
