#!/usr/bin/env bash
set -euo pipefail

release_compose_project="hn-knowledge-release-verify-$$"
release_database_url="postgresql://hn_knowledge:hn_knowledge@127.0.0.1:5432/hn_knowledge"

cleanup() {
  docker compose -p "$release_compose_project" down --volumes --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

export DATABASE_URL="$release_database_url"
export NODE_ENV=test

npm ci
npm run db:validate
npm run db:generate
npm run format:check
npm run lint
npm run typecheck
npm run build
npm test
npm run test:evaluation
npm run evaluation:subjects
npm run test:contract -- --target findthatproject --dry-run
npm run export:audit -- --corpus holdout-v1

docker compose -p "$release_compose_project" up -d postgres
npm run db:test:wait
npm run db:test:reset
npm run db:migrate:deploy
npm run test:integration

npm run db:test:reset
npm run db:migrate:deploy
npm run seed:replay
npm run seed:materialize-shadow
npm run feed:audit -- --corpus seed-v1
npm run benchmark:pipeline -- --fixture seed-v1

docker build -t hn-knowledge:verify .
npm run container:inspect
npm run container:smoke

echo "Release verification passed."
