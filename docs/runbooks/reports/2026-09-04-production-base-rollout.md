# Production base rollout — 2026-09-04

## Scope

The operator authorized the four-service Railway production graph, one API
token, one API domain, and fail-closed smoke checks. Telegram, classifier
provider credentials, export, live ingestion, and synthetic alerts stayed
disabled.

## IaC and deployment

- Railway CLI: `5.49.1`.
- Initial plan: four creates, zero changes, zero destroys. The first apply was
  rejected before mutation because staging already owned the project-global
  resource names.
- Revised plan after explicit approval: create `postgres-production`,
  `api-production`, `worker-production`, and `scheduler-production`; zero
  changes and zero destroys.
- All four services reached `SUCCESS`. PostgreSQL has one ready private volume;
  API and worker each have one running replica; scheduler uses `17 3 * * *`.
- The effective API and worker deployment manifests use `ON_FAILURE` with 10
  retries. CLI `5.49.1` continues to preview those fields as unset, so this is
  recorded as plan-normalization drift rather than repeatedly reapplied.

## Database and exposure

- API is the only service with `npm run db:migrate:deploy`.
- The first API pre-deploy found and applied all nine migrations. The
  token-triggered redeploy found nine migrations and none pending.
- Exactly one public domain exists, on API port `8080`:
  `https://api-production-production-42e8.up.railway.app`.
- Worker, scheduler, and PostgreSQL have no public domain.

## Fail-closed verification

The bounded smoke passed public health/readiness, unauthenticated rejection for
metrics and `/v1/*`, authenticated metrics, expected metric families, and
metrics output safety. Bounded deployment/runtime logs contained no warning or
error events. Worker configuration has `TELEGRAM_ENABLED=false` and
`CLASSIFIER_ENABLED=false`, with no Telegram, classifier-provider, or export
credential present.

## Follow-ups

- Seal `APP_API_TOKEN` once in Railway's authenticated UI; its value was
  generated from 256 random bits, sent through stdin, and never printed or
  written to the repository. Repeat the authenticated smoke after sealing.
- Native monitor routing and live synthetic alert drills remain explicitly
  disabled.
- Production Telegram/source use, bounded ingestion, and export require fresh
  authorization.
