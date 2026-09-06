# Plan 016 completion: search and bookmarks

Date: 2026-09-06. Delivery branch: `codex/016-results-search-and-bookmarks`.

## Result

The local classifier workspace now searches displayed titles and summaries,
including the latest correction, and saves useful prediction results for later
reading. Private browsing still requires no approval, and corrections remain
optional feedback. No classifier prompt, model, evaluation decision, or training
behavior changed.

Search is a case-insensitive literal substring of up to 200 characters. It
combines with the existing result categories or Saved results and runs before
the 20-row page limit. Signed cursors bind the normalized phrase and view, while
the browser ignores responses belonging to an earlier search. Search and view
survive in the result URL. This is title/summary search, not full-source search;
ranking and fuzzy matching are outside this milestone.

Bookmarks belong to specific prediction attempts. Migration 0011 adds unsaved
defaults, an independent version, a saved-view index, and command receipts.
Authenticated desired-state writes use optimistic concurrency and transactionally
store their receipt. Exact retries recover the original receipt without
reapplying an old change; altered command reuse or stale versions return 409.
The browser re-fetches current bookmark state after a write or conflict and
keeps unfinished correction text. Neither saving nor removing a bookmark creates
feedback, an approval, or a new classification.

The UI retains the existing reading layout and shared components: search and
clear controls, Saved results, list/detail save buttons, pending/retry states,
accessible pressed state, and polite confirmation. There are no new dependencies.
The [runbook](../../docs/classifier-results-local.md) documents usage and APIs.

## Verification

All Global verification gate commands passed: clean dependency installation,
formatting, typed lint, type checks, production build, unit tests, PostgreSQL
startup/readiness/migration/integration, test-container teardown, and production
container build. The separate test database used loopback port 55432 and the
guarded `hn_manual_review_test` name, leaving the app database untouched.

| Check | Result |
|---|---|
| Unit | 296 passed |
| Integration | 92 passed |
| Local contracts | 4 passed; 4 external contract checks skipped by dry-run |
| Evaluation fixture regressions | 42 passed; no live classifier evaluation |
| Sealed-cycle validation | All three historical cycles unchanged and valid |
| Web components | 10 passed |
| Browser | 18 distinct journeys passed |
| Accessibility | 4 journeys passed; no serious/critical Axe violations |
| Clean migration | All 13 migrations applied successfully |
| Existing-data upgrade | Original run/snapshot/feedback rows preserved; unsaved defaults verified |
| Container | Built `hn-knowledge:verify` successfully |

New coverage exercises search before pagination, cursor context, maximum-length
Unicode queries, literal `%`, `_`, and backslash matching, corrected display
text, save/remove persistence, concurrent commands, independent correction
versions, exact replay, and stale receipts. Real browser tests let a write commit
and drop its response, then verify the identical retry produces one receipt.
They also cover list/detail synchronization, reload, Saved results, unsaved-edit
navigation protection, two-tab conflicts, and delayed pagination from an earlier
search. One initial browser failure used the old “Correct result” selector after
the app correctly displayed “Continue correction”; that test was corrected and
passed on rerun. The other 17 journeys passed in the full run.

## Local data and visual inspection

Before and immediately after migration, the app contained 121 results, zero
feedback records, and zero approvals. The original 98 snapshots retained their
fingerprint:

`86dc3f0ef4074f753a25c596d6b024fc11c8ea5999ef435a5edfe38ed6bffd7c`

Preparation replayed existing captured data with zero HN fetches. The workspace
was then restarted with its already-enabled bounded feed. At the final status
check it was online with 135 results, 14 requests used that UTC day, and no
pending, processing, or failed jobs. Feedback and approval counts remained zero;
the original fingerprint still matched. Counts can grow through normal intake.

The read-only local browser smoke inspected three result categories, search,
Saved results, source/correction screens, lock behavior, and desktop/mobile
layouts. It made zero mutations and left zero persistent browser-storage
entries. No owner bookmarks or corrections were fabricated. Screenshots under
ignored `output/playwright/` were visually inspected at 1440px and 390px,
including `local-results-search-desktop.png`, `local-results-search-mobile.png`,
and `local-classifier-mobile.png`. The local app runs at
`http://127.0.0.1:5173/?view=results` while its supervisor is running.

## Preceding integration repair

The clean-checkout lint failure was fixed by preparing shared workspace types
before typed lint. Both GitHub checks passed on commit `37d9cd9`, and
[PR 29](https://github.com/pavelivanov/hacker-news-indexer/pull/29) merged into
`main` as `3198742`. The existing Railway API, worker, and scheduler deployments
reported SUCCESS, and the API health endpoint returned `{"status":"ok"}`.
Production classification was not enabled; browser/feed operation remains local.

Broader hosting hardening, feedback export or training, classifier accuracy
review, and the remaining Plan 008 scope stay deferred. The unrelated `.zcode/`
file was preserved.
