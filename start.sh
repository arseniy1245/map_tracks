#!/usr/bin/env sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$ROOT_DIR"

HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-5173}"
NODE_ENV="${NODE_ENV:-production}"
BUILD="${BUILD:-1}"
INSTALL="${INSTALL:-1}"

export HOST PORT NODE_ENV

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required. Install Node.js 20+ and run this script again." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required. Install npm and run this script again." >&2
  exit 1
fi

mkdir -p data/routes data/uploads

if [ ! -f data/telegram-backup.json ] && [ -f data/telegram-backup.example.json ]; then
  cp data/telegram-backup.example.json data/telegram-backup.json
fi

if [ "$INSTALL" = "1" ]; then
  if [ -f package-lock.json ]; then
    npm ci
  else
    npm install
  fi
fi

if [ "$BUILD" = "1" ]; then
  npm run build
fi

echo "Starting route map server on ${HOST}:${PORT}"
exec node server.js --production
