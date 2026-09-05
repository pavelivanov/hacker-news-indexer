# Plan 015: Fresh results and processing recovery

- Status: DONE
- Date: 2026-09-05
- Owner authorization: implement the recommended next A+B milestone, building
  on optional corrections and private results from Plan 014.
- Preserve all existing uncommitted work and local data. No deployment, exports,
  model promotion, prompt tuning, new evaluation cycle, or human approval gate.

## Implementation

1. Add a persistent daily-feed state, isolated queue lane, request budget, and
   retry command receipts. Use forward migrations with historical defaults.
   Add explicit classifier attempt identity so retries never replace originals.
2. Extend the existing Telegram adapter to obtain the latest message ID with
   current documented APIs. Incremental ranges must never advance past observed
   latest content. Initial use starts at the most recent 20 selections, avoiding
   an unbounded historical import. Later checks continue from the saved cursor.
3. Add a local feed worker using the existing ingestion/resolution/classification
   services. Serialize it with a session lock shared with the local generator;
   isolate feed jobs from the legacy worker. Preserve source snapshots before
   provider calls so crash retries reuse the same input. Resume durable jobs,
   bound automatic retries and request usage, and surface configuration errors.
4. Add authenticated processing status, sync/pause/resume, and idempotent failed
   job/result retry endpoints. Report last successful check, freshness, pending
   and failed work, offline state, and daily request consumption. Persist every
   actual provider call reservation before dispatch, including validation retries.
5. Add a compact processing section to the existing results screen. Poll status
   without interrupting reading/corrections, announce new results, and preserve
   edits. Display retries and connection/configuration states in ordinary language.
6. Integrate worker startup into the existing local supervisor using server-only
   credentials. Keep test mode external-call-free. Perform a bounded real source
   sync after deterministic tests; leave the local feed running for owner use.

## Design

Visual thesis: retain the calm reading surface; freshness and processing controls
are a compact secondary strip, with details disclosed on demand.
Content: feed first, last update and sync action second, failure details only when
needed. Interactions: existing focus/hover states, small loading indicator, and
polite live status; respect reduced motion and do not shift reading on polling.

## Verification

Read and execute the Global verification gate in plans/README.md. Use guarded
hn_manual_review_test aliases for destructive DB checks. Add integration coverage
for incremental cursor safety, isolated jobs, request caps, immutable retry
attempts, exact retry receipts, and crash/replay behavior. Run contract, evaluation,
web, real browser, and desktop/mobile accessibility tests. Verify a clean migration
and forward upgrade, inspect browser screenshots, check sealed paths unchanged,
and document live sync counts and remaining limitations in a completion report.

## Stop conditions

- Missing/invalid source or provider credentials block live sync only. Surface the
  actionable status and complete implementation/tests without inventing results.
- Refuse remote/unknown targets for local setup or destructive test commands.
- Never modify sealed evaluation artifacts or treat user feedback as new gold.

## Completion

- [x] Storage, worker, bounded sync, and retries implemented.
- [x] Browser status and controls implemented and visually inspected.
- [x] Global and feature verification passed.
- [x] Live sync completed: 20 new results, 20 requests, no failed jobs.
- [x] Runbook, completion report, and plan index updated.

See [completion report](reports/015-daily-feed-completion.md) for verification,
live counts, preservation checks, and operational limits.
