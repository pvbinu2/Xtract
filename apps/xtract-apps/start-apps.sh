#!/usr/bin/env bash
set -e

cd /app
npm install --include=optional
npm install --workspace apps/web
npm install --include=optional --workspace functions/processor
FUNC_BIN="/app/functions/processor/node_modules/.bin/func"
if [ ! -x "$FUNC_BIN" ]; then
  FUNC_BIN="/app/node_modules/.bin/func"
fi

cd /app/apps/web
npm run dev -- --host 0.0.0.0 &

cd /app/apps/api
npm run dev -- --watch --host 0.0.0.0 &

cd /app/functions/processor
"$FUNC_BIN" start --javascript --host 0.0.0.0

wait
