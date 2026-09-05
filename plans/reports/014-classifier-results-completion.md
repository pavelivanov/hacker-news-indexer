# Plan 014 — classifier results and optional corrections

Date: 2026-09-05. Branch: `codex/013-local-manual-review-mvp`.
Builds on the uncommitted Plan 013 workspace. The owner explicitly chose to
defer classifier verification until normal use and requested a friendly way
to browse results and submit corrections.

## Delivered behavior

The default screen now shows machine results without approval. A divided,
readable list supports All results, Discoveries, Expert notes, Skipped comments,
Uncertain or failed, and Your corrections. Selecting a result shows its summary,
bounded source snapshot, original HN link, cited passages, original prediction,
discovery links, and model/prompt metadata. On mobile, the detail replaces the
list and provides a Back to results control.

**Correct result** opens a short category/title/summary form, issue selector,
and optional explanation. A successful save changes the displayed result and
filter membership immediately. Original output remains available, and the
history records every saved correction. The flow requires no evidence selection,
confidence score, or approval. Feedback alone can be submitted without changing
the result text.

The dialog preserves unsaved writing when closed. Navigation offers a discard
choice. Competing corrections return a conflict while retaining the form;
explicitly loading the current version allows the owner to save the preserved
text. Lost responses retain the exact request for idempotent retry. Reload
requires the local token again, but committed feedback survives.

The owner decision is recorded in ADR 0007 and linked from the prior classifier
endgame and plan index. The advanced manual workspace remains available. Private
results and feedback do not activate model decisions, create human approvals,
publish to the approved reader, enqueue exports, or modify sealed evaluations.
This milestone adds no automatic training or new quality claim.

## Implementation

- Forward migration `0009_classifier_feedback` adds source/output snapshots and
  append-only feedback. Snapshots match the stored classifier input hash and
  provider output. A database trigger prevents changes to original snapshot
  fields; another prevents updates/deletes of correction records.
- The results repository filters before pagination. Cursors are authenticated
  and bound to the selected filter. List/detail/correction routes reuse bearer
  authentication and bounded JSON parsing, with a server-owned actor identity.
- Corrections use a transaction and conditional version increment. One version
  wins concurrent different saves; exact duplicate commands recover the same
  feedback row. Request hashes use a canonical field order, and command-key
  collisions with different bodies return a conflict.
- The browser reuses the existing React/shadcn components and local font. No new
  dependencies were required. Shared feedback validation runs in the form and
  on the server. Source text is escaped; external candidate links accept only
  HTTP(S). Credentials stay in memory and out of browser storage and assets.
- `classifier-results:generate` reads the existing configured provider credential
  server-side and operates only on the isolated captured-source database. It
  requires an explicit 1–100 comment bound, uses two concurrent workers and a
  database advisory lock, reuses existing run identities, and creates snapshots
  without mandatory review tasks. It stops dispatching after authentication or
  provider-configuration failures. No live source intake starts.
- The existing provider request deadline now covers response-body consumption
  as well as response headers. A regression test covers a stalled body.

Current primary Prisma documentation was fetched through Context7 for versioned
transaction updates. The official OpenAI structured-output guide was checked for
the existing request shape. No prompt or model-selection change was made.

## Verification

The full global gate ran successfully with guarded DB aliases targeting
`hn_manual_review_test`. Clean migration reset only this disposable database.
The local demo was subsequently upgraded with its existing data preserved.

| Check | Result |
| --- | --- |
| `npm ci`, formatting, lint, typecheck, build | Passed |
| `npm test` | 285 passed across 39 files |
| `db:test:wait`, `db:validate`, clean migration | Passed; all 11 migrations applied |
| `test:integration` | 74 passed across 13 files |
| `test:contract -- --dry-run` | 3 passed; 4 unrelated/live cases skipped |
| `test:evaluation` | 42 passed; existing fixture benchmark/shadow checks passed |
| `evaluation:validate-cycles` | Passed; all three terminal states unchanged |
| `test:web` | 10 passed across 3 files |
| `test:e2e:web` | 12 real API/PostgreSQL browser journeys passed |
| `test:a11y:web` | 2 desktop/mobile/keyboard scenarios passed |
| `docker compose down` and container build | Passed; image `0da193623932` on Node 24.19.0 |
| Final formatting, lint, and `git diff --check` | Passed after adding the runbook and smoke command |
| `classifier-results:smoke` | 98 results; 3 category screens opened; 0 mutations or browser storage entries; lock cleared token |
| Repeat `classifier-results:generate -- --limit 1` | 98 reused, 0 new attempts |

The seven new integration cases cover upgrade preservation; display without
approval and corrected filter membership; immutable history and command reuse;
concurrent conflicting saves; concurrent exact replays; source changes after
capture; and filter/cursor pagination. Assertions verify zero review/audit/feed
activation writes from corrections. Browser tests exercise save/reload/original
history, two-tab conflicts, and an actual committed correction whose response
is dropped. These mutation tests use synthetic data exclusively.

Desktop and 390-pixel mobile scans have no serious/critical axe violations.
Keyboard operation includes opening/closing the correction dialog. An initial
manual-navigation horizontal overflow was fixed before the successful full gate.
Host checks used Node 24.18.0 within the supported engine range; the container
verified the repository's exact 24.19.0 pin. Existing installation audit findings
(one moderate and one high) and PostgreSQL query-concurrency deprecation warnings
remain as recorded in Plan 013; no dependency upgrades were introduced here.

## Local usability run

Local preparation applied only migration 0009 and replayed the existing capture
with `created: false`, 98 selected comments, and zero HN fetches. The configured
`gpt-5.6-luna` model produced five initial results successfully. A second bounded
command reused those five runs and processed the remaining 93 comments, with
zero processing failures. The complete view contains **39 predicted Expert
notes, 11 predicted Discoveries, and 48 skipped comments**. There are zero
Uncertain/Failed rows and zero owner corrections. These are output counts,
not correctness measurements. No approval or owner correction was submitted.

A third invocation with `--limit 1` reused all 98 stored identities, made zero
new classifier attempts, and preserved the existing snapshots. The final
read-only browser smoke retrieved all 98 through pagination, opened each of
the three available categories and its correction dialog, verified mobile
layout, found zero browser storage entries, and confirmed token clearing on
lock. Actual desktop result and mobile source/correction screenshots were
visually inspected. Sealed evaluation paths and captured seed fixtures have no
working-tree changes.

This is application use, not an accuracy evaluation. No gold comparison,
annotation, quality scoring, or owner feedback was manufactured. The read-only
browser pilot traverses available categories, opens original/source details and
the correction dialog, checks zero browser persistence, and locks the session.

Visual inspection uses these ignored local screenshots:

- [Actual result list](../../output/playwright/local-classifier-results.png)
- [Actual desktop detail](../../output/playwright/local-classifier-detail.png)
- [Actual mobile detail](../../output/playwright/local-classifier-mobile.png)
- [Actual mobile correction form](../../output/playwright/local-classifier-correction.png)
- [Synthetic corrected result](../../output/playwright/classifier-results-desktop.png)

## Remaining scope

- Feedback changes category/title/summary and records an issue/explanation.
  Per-discovery URL/evidence editing and feedback export are not part of this
  form. Those problems can be described in the explanation.
- Corrections do not retrain the model. A later improvement pass must explicitly
  account for overlap between captured examples and historical evaluation data.
- Existing failed run identities are reused rather than automatically retried.
  Scheduled generation, new source intake, hosted access, and classifier worker
  lifecycle repairs remain separate work. General run-replay/lease issues from
  the earlier audit are not claimed fixed by this bounded local generator.
- Browsing currently lists captured runs; it does not collapse future multiple
  model runs into a single latest-only comment view. Correction history is not
  paginated. These are acceptable at the current local volume.
- Browser checks used Chromium. CI is wired to deterministic tests but has not
  run on this unpushed branch. Changes remain local and uncommitted.

The [results runbook](../../docs/classifier-results-local.md) documents startup,
the local token, generation bounds, corrections, storage, API contracts, and
test isolation. The local API, Vite server, and PostgreSQL are left running for
the owner at `http://127.0.0.1:5173/?view=results`.
