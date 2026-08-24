#!/usr/bin/env bash
set -euo pipefail

api_container_name="hn-knowledge-api-smoke-$$"
worker_container_name="hn-knowledge-worker-smoke-$$"
host_port="${HN_KNOWLEDGE_SMOKE_PORT:-38080}"

cleanup() {
  docker rm -f "$api_container_name" "$worker_container_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run --detach \
  --name "$api_container_name" \
  --publish "127.0.0.1:${host_port}:3000" \
  --env NODE_ENV=production \
  --env PORT=3000 \
  --env DATABASE_URL=postgresql://unused:unused@127.0.0.1:1/unused \
  hn-knowledge:verify >/dev/null

for attempt in $(seq 1 30); do
  if curl --fail --silent "http://127.0.0.1:${host_port}/healthz" | grep --quiet '"status":"ok"'; then
    echo "Container health check passed after ${attempt} attempt(s)."
    docker stop --timeout 10 "$api_container_name" >/dev/null
    docker logs "$api_container_name" 2>&1 | grep --quiet 'api_stopped'
    echo "API handled SIGTERM cleanly."
    break
  fi
  if [ "$attempt" -eq 30 ]; then
    docker logs "$api_container_name" --tail 50
    echo "Container health check did not pass within 30 seconds." >&2
    exit 1
  fi
  sleep 1
done

docker run --detach \
  --name "$worker_container_name" \
  --env NODE_ENV=production \
  hn-knowledge:verify \
  node --enable-source-maps apps/worker/dist/index.js >/dev/null

for attempt in $(seq 1 30); do
  if docker logs "$worker_container_name" 2>&1 | grep --quiet 'worker_started'; then
    docker stop --timeout 10 "$worker_container_name" >/dev/null
    docker logs "$worker_container_name" 2>&1 | grep --quiet 'worker_stopped'
    echo "Worker handled SIGTERM cleanly after ${attempt} attempt(s)."
    exit 0
  fi
  if [ "$attempt" -eq 30 ]; then
    docker logs "$worker_container_name" --tail 50
    echo "Worker did not start within 30 seconds." >&2
    exit 1
  fi
  sleep 1
done
