#!/usr/bin/env bash
# Unpack a GitHub Actions artifact on EC2. Never run `npm run build` here.
# Never modify nginx, security groups, or other AWS resources.
# Preserves .env and google-credentials.json already on the instance (not in the artifact).
#
# Layout (Amazon Linux 2023, system Node — no nvm):
#   APP_DIR=/opt/ol/apps/live-server
#   LOG_DIR=/opt/ol/logs
#   APP_USER=olapp
set -euo pipefail

APP_USER="${APP_USER:-olapp}"
APP_DIR="${APP_DIR:-/opt/ol/apps/live-server}"
LOG_DIR="${LOG_DIR:-/opt/ol/logs}"
ARTIFACT="${ARTIFACT:-/tmp/live-server-artifact.tgz}"
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=512}"

if [ ! -f "$ARTIFACT" ]; then
  echo "missing artifact: $ARTIFACT" >&2
  exit 1
fi

if [ "$(id -un)" != "$APP_USER" ] && [ "$(id -u)" -ne 0 ]; then
  echo "must run as ${APP_USER} or root (root drops privileges for npm/pm2)" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "system node/npm not found in PATH (expected Node 20 / npm 10, no nvm)" >&2
  exit 1
fi

echo "node $(node -v) npm $(npm -v) user=$(id -un)"

mkdir -p "$APP_DIR" "$LOG_DIR"

if [ "$(id -u)" -eq 0 ]; then
  if ! id "$APP_USER" >/dev/null 2>&1; then
    echo "missing Linux user ${APP_USER}" >&2
    exit 1
  fi
  chown "$APP_USER:$APP_USER" "$APP_DIR" "$LOG_DIR"
  chmod a+r "$ARTIFACT"
  if [ -f "$APP_DIR/.env" ]; then
    chown "$APP_USER:$APP_USER" "$APP_DIR/.env"
  fi
  if [ -f "$APP_DIR/google-credentials.json" ]; then
    chown "$APP_USER:$APP_USER" "$APP_DIR/google-credentials.json"
  fi
fi

as_olapp() {
  if [ "$(id -u)" -eq 0 ]; then
    runuser -u "$APP_USER" -- "$@"
  else
    "$@"
  fi
}

# LIVE-51: before anything on disk changes, check the new prisma/schema.prisma against the live
# database (ol-node-rest owns the tables). Drift aborts the deploy with the running version and its
# files untouched. If the check itself can't run (first deploy, CLI missing) it only warns.
# SKIP_SCHEMA_CHECK=1 bypasses it in an emergency.
if [ "${SKIP_SCHEMA_CHECK:-0}" != "1" ] && [ -x "$APP_DIR/node_modules/.bin/prisma" ]; then
  CHECK_DIR="$(mktemp -d)"
  chmod 755 "$CHECK_DIR"
  if tar -xzf "$ARTIFACT" -C "$CHECK_DIR" prisma/schema.prisma scripts/check-schema-drift.mjs 2>/dev/null; then
    chown -R "$APP_USER:$APP_USER" "$CHECK_DIR" 2>/dev/null || true
    if as_olapp bash -c "cd '$APP_DIR' && ./node_modules/.bin/prisma db pull --print > '$CHECK_DIR/db.prisma' 2> '$CHECK_DIR/pull.err'"; then
      if ! as_olapp node "$CHECK_DIR/scripts/check-schema-drift.mjs" "$CHECK_DIR/db.prisma"; then
        echo "schema drift between this release and the live database; deploy aborted, nothing changed" >&2
        rm -rf "$CHECK_DIR"
        exit 1
      fi
    else
      echo "warning: prisma db pull failed, schema check skipped: $(head -c 300 "$CHECK_DIR/pull.err")" >&2
    fi
  else
    echo "warning: artifact has no schema checker, schema check skipped" >&2
  fi
  rm -rf "$CHECK_DIR"
fi

echo "extracting $ARTIFACT -> $APP_DIR (keeping existing .env)"
as_olapp tar -xzf "$ARTIFACT" -C "$APP_DIR"

as_olapp env \
  APP_DIR="$APP_DIR" \
  NODE_OPTIONS="$NODE_OPTIONS" \
  PATH="$PATH" \
  bash -c '
set -euo pipefail
cd "$APP_DIR"

echo "npm ci --omit=dev"
npm ci --omit=dev --no-audit --no-fund

pm2_ensure() {
  local name="$1"
  local script="$2"
  if pm2 describe "$name" >/dev/null 2>&1; then
    echo "pm2 restart $name"
    pm2 restart "$name"
  else
    echo "pm2 start $script --name $name"
    pm2 start "$script" --name "$name"
  fi
}

pm2_ensure ol-live server.js

pm2 save
pm2 list
echo "live-server deploy complete"
'
