#!/usr/bin/env bash
set -e

python -m uvicorn backend.app:app --host 0.0.0.0 --port 8000 &
BACKEND_PID=$!

cleanup() {
  kill "${BACKEND_PID}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Avoid race condition: wait until backend accepts requests
for i in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:8000/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

if ! curl -fsS "http://127.0.0.1:8000/health" >/dev/null 2>&1; then
  echo "Backend did not become healthy in time"
  exit 1
fi

node /app/web/server.js
