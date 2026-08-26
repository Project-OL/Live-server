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
