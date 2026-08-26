#!/usr/bin/env bash
set -euo pipefail

image_name="${HN_KNOWLEDGE_IMAGE:-hn-knowledge:verify}"
smoke_suffix="$$"
network_name="hn-knowledge-smoke-${smoke_suffix}"
postgres_container_name="hn-knowledge-postgres-smoke-${smoke_suffix}"
api_container_name="hn-knowledge-api-smoke-${smoke_suffix}"
worker_container_name="hn-knowledge-worker-smoke-${smoke_suffix}"
host_port="${HN_KNOWLEDGE_SMOKE_PORT:-38080}"
smoke_directory="$(mktemp -d)"
database_password="release_smoke_password"
database_url="postgresql://hn_knowledge:${database_password}@${postgres_container_name}:5432/hn_knowledge"
api_token="release-smoke-api-secret"
export_token="release-smoke-export-secret"

cleanup() {
  docker rm -f \
    "$api_container_name" \
    "$worker_container_name" \
    "$postgres_container_name" >/dev/null 2>&1 || true
  docker network rm "$network_name" >/dev/null 2>&1 || true
  rm -rf "$smoke_directory"
}
trap cleanup EXIT

docker network create "$network_name" >/dev/null
docker run --detach \
  --name "$postgres_container_name" \
  --network "$network_name" \
  --env POSTGRES_DB=hn_knowledge \
  --env POSTGRES_USER=hn_knowledge \
  --env "POSTGRES_PASSWORD=${database_password}" \
  postgres:17-bookworm >/dev/null

for attempt in $(seq 1 30); do
  if docker exec "$postgres_container_name" \
    pg_isready -U hn_knowledge -d hn_knowledge >/dev/null 2>&1; then
    break
  fi
  if [ "$attempt" -eq 30 ]; then
    docker logs "$postgres_container_name" --tail 50
    echo "PostgreSQL smoke container did not become ready." >&2
    exit 1
  fi
  sleep 1
done

docker run --rm \
  --network "$network_name" \
  --env NODE_ENV=production \
  --env "DATABASE_URL=${database_url}" \
  "$image_name" npm run db:migrate:deploy >"${smoke_directory}/migration.log" 2>&1

docker run --detach \
  --name "$api_container_name" \
  --network "$network_name" \
  --publish "127.0.0.1:${host_port}:3000" \
  --env NODE_ENV=production \
  --env PORT=3000 \
  --env "DATABASE_URL=${database_url}" \
  --env "APP_API_TOKEN=${api_token}" \
  --env "EXPORT_CONSUMER_TOKEN=${export_token}" \
  "$image_name" >/dev/null

for attempt in $(seq 1 30); do
  if curl --fail --silent "http://127.0.0.1:${host_port}/healthz" | grep --quiet '"status":"ok"' \
    && curl --fail --silent "http://127.0.0.1:${host_port}/readyz" | grep --quiet '"status":"ok"' \
    && curl --fail --silent \
      --header "Authorization: Bearer ${api_token}" \
      "http://127.0.0.1:${host_port}/metrics" | grep --quiet 'pipeline_failure_total'; then
    echo "API liveness, readiness, and authenticated metrics passed after ${attempt} attempt(s)."
    break
  fi
  if [ "$attempt" -eq 30 ]; then
    docker logs "$api_container_name" --tail 50
    echo "API smoke checks did not pass within 30 seconds." >&2
    exit 1
  fi
  sleep 1
done

docker exec -i "$postgres_container_name" \
  psql -v ON_ERROR_STOP=1 -U hn_knowledge -d hn_knowledge >"${smoke_directory}/seed.log" <<'SQL'
WITH smoke_run AS (
  INSERT INTO ingestion_runs (
    source,
    source_key,
    min_id,
    max_id,
    request_key,
    status,
    updated_at
  ) VALUES (
    'FIXTURE',
    'release-smoke',
    1,
    1,
    'release-smoke-request',
    'RUNNING',
    CURRENT_TIMESTAMP
  )
  RETURNING id
)
INSERT INTO pipeline_jobs (
  ingestion_run_id,
  type,
  payload,
  idempotency_key,
  state,
  attempts,
  available_at,
  lease_owner,
  lease_expires_at,
  updated_at
)
SELECT
  id,
  'INGEST_SELECTION_RANGE',
  '{"source":"FIXTURE","sourceKey":"release-smoke","minId":1,"maxId":1,"requestKey":"release-smoke-request"}'::jsonb,
  'release-smoke-expired-lease',
  'LEASED',
  1,
  CURRENT_TIMESTAMP - INTERVAL '2 minutes',
  'dead-worker',
  CURRENT_TIMESTAMP - INTERVAL '1 minute',
  CURRENT_TIMESTAMP
FROM smoke_run;
SQL

docker run --detach \
  --name "$worker_container_name" \
  --network "$network_name" \
  --env NODE_ENV=production \
  --env "DATABASE_URL=${database_url}" \
  --env WORKER_CONCURRENCY=1 \
  --env WORKER_POLL_INTERVAL_MS=50 \
  --env WORKER_LEASE_DURATION_MS=3000 \
  --env WORKER_MAX_ATTEMPTS=1 \
  "$image_name" node --enable-source-maps apps/worker/dist/index.js >/dev/null

for attempt in $(seq 1 60); do
  recovered_state="$(docker exec "$postgres_container_name" \
    psql -At -U hn_knowledge -d hn_knowledge \
    -c "SELECT state || ':' || attempts FROM pipeline_jobs WHERE idempotency_key = 'release-smoke-expired-lease'")"
  if [ "$recovered_state" = "TERMINAL:2" ]; then
    echo "Worker recovered and terminally handled the expired lease."
    break
  fi
  if [ "$attempt" -eq 60 ]; then
    docker logs "$worker_container_name" --tail 50
    echo "Worker did not recover the expired lease." >&2
    exit 1
  fi
  sleep 0.1
done

if ! docker run --rm \
  --network "$network_name" \
  --env NODE_ENV=production \
  --env "DATABASE_URL=${database_url}" \
  "$image_name" npm run schedule:once -- --key release-smoke --limit 10 \
  >"${smoke_directory}/scheduler.log" 2>&1; then
  tail -n 50 "${smoke_directory}/scheduler.log"
  echo "Scheduler smoke command failed." >&2
  exit 1
fi
if ! grep --quiet 'reconciliation_schedule_completed' "${smoke_directory}/scheduler.log"; then
  tail -n 50 "${smoke_directory}/scheduler.log"
  echo "Scheduler smoke did not emit its completion marker." >&2
  exit 1
fi

docker stop --timeout 10 "$api_container_name" "$worker_container_name" >/dev/null
docker logs "$api_container_name" >"${smoke_directory}/api.log" 2>&1
docker logs "$worker_container_name" >"${smoke_directory}/worker.log" 2>&1
if ! grep --quiet 'api_stopped' "${smoke_directory}/api.log"; then
  tail -n 50 "${smoke_directory}/api.log"
  echo "API did not emit its graceful shutdown marker." >&2
  exit 1
fi
if ! grep --quiet 'worker_stopped' "${smoke_directory}/worker.log"; then
  tail -n 50 "${smoke_directory}/worker.log"
  echo "Worker did not emit its graceful shutdown marker." >&2
  exit 1
fi

if grep -R -E \
  "${api_token}|${export_token}|${database_password}|postgresql://" \
  "$smoke_directory" >/dev/null; then
  echo "A release smoke secret appeared in logs." >&2
  exit 1
fi

echo "Container role, lease recovery, shutdown, and secret-log smokes passed."
