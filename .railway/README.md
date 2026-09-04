# Railway configuration

This project defines its Railway infrastructure in code.

```txt
.railway/railway.ts
```

Use this file to describe the Railway project you want: services, databases, buckets, custom domains, replicas, groups, and environment variables.

## Common commands

Create the configuration files:

```bash
railway config init
```

Import an existing Railway project into code:

```bash
railway config pull
```

Preview what Railway would change:

```bash
railway config plan
```

Apply the planned changes:

```bash
railway config apply
```

## Notes

- `railway config plan` is safe and does not change Railway.
- `railway config apply` previews changes and asks before applying unless you pass `--yes`.
- Destructive changes in non-interactive or agent sessions require `railway config apply --confirm-destructive` after reviewing the plan.
- Services already managed by `railway.json` must be migrated before `.railway/railway.ts` can manage them.
- Keep one `.railway` file for the whole project. A named `export const partial` (or `PARTIAL` / `const Partial`) is a last resort for separate repos that cannot share that file. Do not add it unless omit=delete across repos is a blocker.
- The legacy `telegram-session` volume is conditional on `staging`; production
  must not create or mount it. Always plan both environments after changing
  environment-conditional resources.
- Railway service names are project-global. Keep the established staging names
  (`postgres`, `api`, `worker`, `scheduler`) and the production-specific names
  (`postgres-production`, `api-production`, `worker-production`,
  `scheduler-production`) distinct.
- Staging has sealed variables managed outside IaC. A staging plan that deletes
  those variables is destructive drift and must never be applied.
- `APP_API_TOKEN` is declared with `preserve()` so IaC never reads, creates, or
  deletes its out-of-band value. Do not remove that marker while either
  environment has an API token.
- Railway CLI `5.49.1` may continue to preview the API/worker restart policy as
  unset after applying it. Verify the latest deployment manifests show
  `ON_FAILURE` with 10 retries; do not repeat applies solely to clear that
  preview-normalization drift.
- Use `replicas` for scaling; advanced placement can still specify region names.
- Use `group("Name", [resources])` to keep large projects organized on the Railway canvas.
- Secrets imported from Railway are rendered as `preserve()` so existing values are retained without writing secret values to source. Use `railway config pull --omit-preserved-variables` for a smaller import.
