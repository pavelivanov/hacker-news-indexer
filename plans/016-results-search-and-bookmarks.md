# Plan 016: Search classifier results and save useful items

- Status: DONE
- Date: 2026-09-06
- Baseline: `37d9cd9`, following Plans 013–015 and the clean-checkout CI repair.
- Owner authorization: continue the recommended CI → merge → search/bookmarks work.

## Scope and behavior

1. Add case-insensitive literal substring search over the displayed title and
   summary, including the latest correction. Bound the query to 200 characters;
   empty/whitespace input means no search. Preserve category filtering and stable
   20-row pagination, applying search before the page limit. Bind signed cursors
   to the normalized search and filter; reject duplicate/unknown API query fields.
2. Add persistent bookmark state/version to each immutable result snapshot via a
   forward migration. Existing results default to unsaved. A bookmark belongs to
   a specific prediction attempt and remains independent of feedback/approval.
   Add a receipt table for idempotent desired-state writes with optimistic version
   checks. Exact retries return the original receipt; stale conflicting writes
   return 409. Do not overwrite predictions or source snapshots.
3. Add an authenticated bookmark endpoint and include saved state in list/detail
   DTOs. Reuse the shared contract, application service, repository, bearer auth,
   bounded body parser, and safe conflict errors. No new external dependency.
4. Reuse the current React/shadcn workspace: search form with clear action,
   descriptive empty state, Saved results filter, and save/remove controls in
   list and detail. Preserve search/filter in result URLs and after reload.
   Keep unsaved corrections protected during navigation. Ignore stale list or
   pagination responses when the search changes. Bookmark retries preserve their
   exact command after an uncertain response; concurrent-tab conflicts reload
   bookmark state without discarding correction text.
5. Add database, API, real browser, and accessibility coverage. Apply the migration
   to the local database while preserving existing result/feedback data, then
   inspect the actual desktop/mobile UI without fabricating owner bookmarks or
   corrections. Update runbooks and the plan index; commit and push the feature.

## Design

Visual thesis: extend the calm reading workspace with a compact search row and
quiet save controls, retaining existing typography, dividers, and green accent.
Content order: search/filter → processing status → result list → selected detail.
Interactions: explicit search submission, clear pending button state, existing
hover/focus transitions, and polite confirmation; respect reduced motion and
keep controls usable at 390px. No decorative imagery or new navigation system.

## Verification

Run the Global verification gate from `plans/README.md`, plus contract,
evaluation, sealed-cycle, web component, real browser, and accessibility checks.
Use a separate local PostgreSQL container on loopback port 55432 with database
`hn_manual_review_test` for the full gate, leaving the working app database
untouched. Run destructive commands only after the test-target guard. Use root
npm aliases. Test a clean migration and forward upgrade preserving original
snapshots/feedback, search before pagination, literal special characters,
cursor context, concurrent writes, replay/conflicts, and lost browser responses.

## Stop conditions and boundaries

- Refuse an unknown/remote target for test reset or local migration.
- Never modify sealed evaluation evidence or classify feedback as gold.
- No classifier quality verification, prompt/model tuning, training, feedback
  export, new hosting, or settings editor. No automatic approval requirement.
- Preserve the unrelated `.zcode/` file and the running local data.

## Completion

- [x] Search, bookmarks, contracts, migration, and UI implemented.
- [x] Global/feature verification and migration upgrade passed.
- [x] Real local UI inspected; existing data preserved.
- [x] Runbook/report/index updated; delivered on `codex/016-results-search-and-bookmarks`.

See the [completion report](reports/016-search-bookmarks-completion.md) for
verification results and delivery details.
