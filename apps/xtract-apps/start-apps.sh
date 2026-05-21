#!/usr/bin/env bash
set -e

cd /app
npm install

cd /app/apps/web
npm run dev -- --host 0.0.0.0 &

cd /app/apps/api
npm run dev -- --watch --host 0.0.0.0 &

cd /app/functions/processor
npx func start --javascript --host 0.0.0.0

wait
