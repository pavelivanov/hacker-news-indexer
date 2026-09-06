# Plan 017: Browser feed settings

- Status: DONE
- Baseline: `acc5d03`, including Plan 016 (PR 30 remains separate).
- Authorization: the owner selected recommendation 3, browser settings.

## Scope

Expose two existing local feed controls in Processing details → Feed settings:
check interval (whole minutes, 1–1440) and daily classifier request limit
(1–1000). Preserve the current values until the owner saves a change. Keep
batch size, source, credentials, prompts, and models outside this form.

Use the existing shared contracts, bearer authentication, application service,
PostgreSQL repository, and shadcn dialog/field/input/button components. Add an
independent settings version through migration 0012, and reuse command receipts
with a settings-specific request hash. Authenticated PUT `/v1/processing/settings`
validates strict fields, version, and command key. Concurrent edits conflict;
exact retries return their receipt without replaying an older configuration.

Save changes without restarting the worker. Changing the interval schedules the
next automatic check from the save time, preserving any explicitly requested
sync and pause state. A source check that fails after a save cannot overwrite
the newer schedule. Changes to the request limit never reset usage. Reservations
read the current limit under the same state-row lock as settings writes. Requests
already reserved can finish. Budget-blocked jobs become runnable when allowance
becomes available; serialize deferral with settings saves so a concurrent increase
cannot leave a job stranded until midnight. Do not change unrelated retry delays.

The dialog keeps inputs stable across status polling, reports validation inline,
freezes an uncertain command for exact retry, and offers an explicit reload after
a conflict. Cancel closes without saving. A save never resumes paused updates or
submits content feedback/approval. Status polling must not regress settings to an
older version after a save. Include a short note that the cap counts requests,
resets at midnight UTC, and does not cap spending in dollars.

Visual thesis: a compact utility form within the existing quiet reading workspace.
Content: two fields, current usage/effect explanation, save/cancel and recovery.
Interaction: reuse the existing dialog transition and button focus/hover/pending
states, respect reduced motion, and fit a 390px screen. No imagery or new library.

## Verification and delivery

Run the full Global verification gate in `plans/README.md`, plus contract dry-run,
evaluation fixture regressions/cycle validation, web components, real browser,
and accessibility suites. Use a disposable local PostgreSQL database named
`hn_manual_review_test` on port 55432; run its target guard before reset. Test
clean migration and preservation of an existing non-default configuration.

Cover invalid/missing/extra input, authentication, persistence, idempotency and
conflicts, scheduling, pause preservation, atomic limits, cap lowering during a
validation retry, budget release after an increase (including deferral races),
and zero feedback/bookmark/prediction changes. Browser tests use real database
writes only in the disposable test target; include polling while editing,
reload, lost responses, stale settings, and keyboard/mobile accessibility.

Update the runbook, completion report, and plan index. Migrate/restart the local
workspace after recording its settings and existing snapshot fingerprint; inspect
the real dialog without modifying owner settings. Commit/push the feature branch.
Use `npm run feed:status -- --snapshot` for the read-only upgrade comparison;
its explicit columns also work before migration 0012 is applied.

## Boundaries

- Do not merge PR 30 as part of this selected item, or implement startup/backups.
- No classifier quality review, promotion, tuning, training, feedback export,
  new hosting, or manual content-approval requirement.
- Preserve `.zcode/`, local data, sealed evaluation evidence, and provider secrets.
- Stop before any test reset against an unknown/non-test database.
