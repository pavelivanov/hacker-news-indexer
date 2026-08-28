#!/usr/bin/env bash
set -euo pipefail

image_name="${HN_KNOWLEDGE_IMAGE:-hn-knowledge:verify}"
runtime_user="$(docker image inspect --format '{{.Config.User}}' "$image_name")"
if [ "$runtime_user" != "node" ]; then
  echo "Release image must run as node, found: ${runtime_user}" >&2
  exit 1
fi

node_version="$(docker run --rm "$image_name" node --version)"
if [ "$node_version" != "v24.19.0" ]; then
  echo "Release image Node version mismatch: ${node_version}" >&2
  exit 1
fi

if docker image inspect --format '{{json .Config.Env}}' "$image_name" \
  | grep -E 'DATABASE_URL|APP_API_TOKEN|EXPORT_CONSUMER_TOKEN|TELEGRAM_API|TELEGRAM_SESSION|CLASSIFIER_API_TOKEN' >/dev/null; then
  echo "Release image configuration contains a secret variable." >&2
  exit 1
fi
if docker history --no-trunc "$image_name" \
  | grep -E 'DATABASE_URL=|APP_API_TOKEN=|EXPORT_CONSUMER_TOKEN=|TELEGRAM_API_(ID|HASH)=|TELEGRAM_SESSION=|CLASSIFIER_API_TOKEN=' >/dev/null; then
  echo "Release image history contains a secret assignment." >&2
  exit 1
fi

docker run --rm "$image_name" sh -ceu '
  test -x /app/node_modules/.bin/prisma
  test -f /app/packages/db/prisma.config.ts
  test -d /app/packages/db/prisma/migrations
  test ! -e /app/.env
  test ! -e /app/tests
  test ! -e /app/scripts
  test ! -e /app/plans
  test ! -e /app/.git
  test ! -e /app/.sessions
  test -z "$(find /app -type f \( -name ".env*" -o -name "*.session" -o -name "*.session-journal" \) -print -quit)"
  node -e "const p=require(\"/app/package.json\"); for (const key of [\"start:api\",\"start:worker\",\"schedule:once\",\"db:migrate:deploy\"]) { if (typeof p.scripts?.[key] !== \"string\") process.exit(1); }"
'

echo "Release image identity, runtime tools, role commands, and secret exclusions passed."
