# AGENTS.md

Conventions for agents and humans executing work in this repository.

## Workspace map

- `apps/api` — Hono HTTP service.
- `apps/worker` — Postgres-backed job queue worker.
- `packages/domain`, `packages/application`, `packages/ports`,
  `packages/adapters`, `packages/contracts`, `packages/config`,
  `packages/db` — layered TypeScript packages (Prisma lives in
  `packages/db`).
- `scripts/` — ops commands, routed through npm aliases (see below).
- `evaluation/` — frozen, digest-pinned evaluation artifacts.
- `plans/` — numbered execution plans plus the status table in
  `plans/README.md`.

## Routing rule

Run every ops command through its npm alias in the root `package.json`
(for example `npm run evaluation:validate-cycles`, `npm run seed:replay`,
`npm run eval -- --cycle v3 ...`). Never invoke `tsx scripts/…` by hand
with custom paths — the aliases carry the argument validation and path
guards that keep frozen artifacts safe.

## The one hard rule

Never hand-create, edit, or regenerate anything under `evaluation/cycles/`,
`evaluation/reports/` (non-fixture files), `evaluation/annotations/`, or
`evaluation/captures/`. These are digest-pinned sealed evidence; changes go
through the scripts that own them, exclusively. Annotator output is stored
under `evaluation/annotations/<cycle>/` (or `failed/<cycle>/`) — it never
lands at the repository root.

## Test tiers

- `npm test` — unit tests. Always required.
- `npm run test:integration` — required for DB-touching changes. Needs
  `docker compose up -d postgres`, then `npm run db:test:wait` and
  `npm run db:migrate:deploy`.
- `npm run test:contract` — contract tests; required for adapter/contract
  changes.
- `npm run test:evaluation` — required for anything under
  `packages/application/src/classification/` or `evaluation/`.

## Global verification gate

The global end-of-plan gate is defined in `plans/README.md` under
"Global verification gate" — run the full command block listed there. Do
not duplicate the block here; if that gate ever changes, update
`plans/README.md` and this section together (update both or neither).

## Pointers

- `docs/decisions/` — ADRs, especially `0005-classifier-provider.md`.
- `evaluation/README.md` — the evaluation corpus, cycles, and commands.
- `docs/annotation-guide.md` — annotation instructions.
- `plans/README.md` — plan status table and ordering/dependency graph.

Before executing any plan, read it fully, honor its STOP conditions, run
every verification command it lists, and update its status row when done.
