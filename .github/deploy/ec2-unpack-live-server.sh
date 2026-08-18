#!/usr/bin/env bash
# Unpack a GitHub Actions artifact on ol-dev. Never run `npm run build` here.
# Preserves .env and google-credentials.json already on the instance.
set -euo pipefail

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

APP_DIR="${APP_DIR:-$HOME/live-server}"
ARTIFACT="${ARTIFACT:-/tmp/live-server-artifact.tgz}"

if [ ! -f "$ARTIFACT" ]; then
  echo "missing artifact: $ARTIFACT" >&2
  exit 1
fi

mkdir -p "$APP_DIR"
echo "extracting $ARTIFACT -> $APP_DIR (keeping existing .env)"
tar -xzf "$ARTIFACT" -C "$APP_DIR"

cd "$APP_DIR"
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=512}"

echo "npm ci --omit=dev"
npm ci --omit=dev --no-audit --no-fund

echo "pm2 restart ol-live"
pm2 restart ol-live
pm2 save

pm2 list
echo "live-server deploy complete"
