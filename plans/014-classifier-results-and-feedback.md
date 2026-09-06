# Plan 014: Browse classifier results and correct them during use

- Status: DONE
- Date: 2026-09-05
- Owner decision: classifier verification and approval are optional; show results
  immediately and collect corrections during normal use.
- Builds on: the local Plan 013 workspace. Preserve its existing data and work.

## Scope and implementation

1. Record the revised operating policy. Historical classifier evaluations remain
   unchanged; private machine-result visibility no longer requires approval.
   Keep human-approved reader/export provenance distinct. No deployment, live
   ingestion, promotion claim, prompt tuning, or new evaluation cycle.
2. Persist a bounded source snapshot for each classifier run and an append-only
   correction history. Keep original output/model/prompt/source identity. Store
   corrected category, title, summary, issue, optional explanation, actor, and
   version. Corrections update the private result display immediately; they do
   not train the model or rewrite classification decisions or sealed evidence.
3. Add authenticated result list/detail and correction endpoints. Apply filters
   before pagination; support discoveries, notes, skipped, uncertain/failed,
   and corrected results. Enforce body bounds, optimistic versions, exact retry
   idempotency, and server-owned actor identity. Render source text safely.
4. Make results the default browser screen. Reuse existing design/components:
   a readable list, compact filters, source detail, and a short correction form.
   Keep corrections optional and make originals/history accessible. Preserve
   unsaved text on errors and navigation. Keep the advanced manual workspace.
5. Provide a guarded local generation command over captured comments, reusing
   the configured provider and existing classifier validation. Bound batch size,
   serialize generation, reuse stored runs, and persist source snapshots. Keep
   credentials on the server. Display failures without a mandatory review queue.
   Close the existing provider deadline gap through response-body consumption.
6. Verify unit/contract/integration, real browser correction persistence and
   conflict recovery, desktop/mobile accessibility, and all global gates from
   plans/README.md. Apply migrations to the isolated test DB first and prove
   clean/upgrade paths. Generate real local results if the existing credential
   works, without consulting gold labels or scoring model quality. Document
   results, remaining limitations, startup, and feedback storage.

## Visual direction

Calm off-white reading surface, strong titles, a single green accent, and
divided result rows. Filters orient the collection; selecting a result opens
source and optional corrections. Small entry/focus/status transitions use the
existing reduced-motion rules. No approval checklist in the reading flow.

## Verification

Run the full Global verification gate in plans/README.md using the guarded
hn_manual_review_test environment for DB commands. Also run test:contract
--dry-run, test:evaluation, evaluation:validate-cycles, test:web, test:e2e:web,
and test:a11y:web. New tests must prove no approval/active pointer/export writes,
source snapshot persistence, correction history and retries, filters after
correction, secret clearing, and full browser save/reload behavior. Tests use
synthetic provider fixtures exclusively. Live output is a usability run, not
evaluation evidence. No owner corrections will be fabricated for live data.

## Stop conditions

- Missing provider credentials block live population only, not implementation.
- Unknown/remote/demo target for destructive tests: correct the target first.
- Never relabel machine results as human-approved or silently modify sealed
  evaluation data to make this direction appear to pass the previous gates.

## Completion

- [x] Policy, results, corrections, and local generation implemented.
- [x] Global and feature gates passed; browser visually inspected.
- [x] All 98 captured comments processed; no processing failures. Repeat generation reused all 98 without new requests.
- [x] [Completion report](reports/014-classifier-results-completion.md) and plan index updated.
