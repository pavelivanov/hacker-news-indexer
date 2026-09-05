# Browse classifier results and leave corrections

The default browser screen shows classifier output immediately. Read what is
useful and leave a correction whenever you notice a mistake. There is no
verification checklist or approval step for this private results view.

## Start locally

Use Node 24 and run these commands from the repository root:

```bash
npm ci
npm run build
docker compose up -d postgres
npm run manual-review:prepare-local
npm run dev:manual-review
```

The existing command names are retained for compatibility. Preparation applies
migrations and replays captured sources into the isolated `hn_manual_review`
database, preserving existing results, feedback, drafts, and approvals. It
does not fetch new HN or Telegram content.

Automatic updates read `CLASSIFIER_PROVIDER=openai`, `CLASSIFIER_MODEL`, and
`CLASSIFIER_API_TOKEN` from the existing root `.env` file. Optional
`CLASSIFIER_REASONING_EFFORT` defaults to `low`. These credentials stay in the
server process; they are not sent to the browser. The command uses the configured
model without changing prompts or evaluating its accuracy. Provider usage is
billed to that credential's account.

The supervisor also starts a local feed worker. It checks Telegram every 30
minutes, handles at most 20 selection IDs per sync, and reserves at most 100
classifier requests per UTC day. Telegram credentials also come from the root
`.env`. See [automatic updates and recovery](daily-feed-local.md) for setup,
request limits, pause/resume, retries, and startup troubleshooting.

For captured comments that have no results, the older explicit command remains
available: `npm run classifier-results:generate -- --limit 98`. Run it with the
workspace stopped; generation and the feed worker share an exclusive lock.
Its required `--limit` accepts 1–100 new comments, with up to two concurrent
comments and one validation retry each. It has its own invocation bound and is
not included in the automatic worker's daily allowance. Matching runs are reused.

Open [Classifier results](http://127.0.0.1:5173/?view=results). Copy
`APP_API_TOKEN` from `.env.manual-review.local` into **Local API token** and
unlock. This is the local application token, not the provider credential.
The browser keeps it in memory only. Reload or **Lock** clears it; saved
feedback remains in PostgreSQL. Both servers bind to loopback.

## Read and correct during use

1. Browse **All results**, **Discoveries**, or **Expert notes**. **Skipped
   comments** and **Uncertain or failed** show what did not become retained
   content. **Your corrections** shows results you have changed.
2. Open a result to read its summary and the source snapshot supplied to the
   classifier. Cited passages are marked. The Hacker News link opens the
   original comment. **Original prediction & model details** includes the
   initial category, extracted content, discovery links, and model metadata.
3. If something is wrong, choose **Correct result**. Change the category,
   title, or summary, select what needs improving, and optionally explain why.
   You can leave feedback without changing the text. Discoveries and Expert
   notes require a title and summary; Skipped and Uncertain do not.
4. **Save correction** updates the displayed result immediately. Its original
   prediction remains available, and **Your correction history** records each
   saved version. You can return and correct it again at any time.

No evidence selection, confidence score, or approval reason is required.
Closing the correction dialog keeps unsaved writing until you navigate away.
Navigation warns before discarding edits. A conflict from another tab preserves
your text: choose **Use latest version, keep my text**, then save. If a response
is lost, **Retry same correction** safely recovers the same save without adding
duplicate feedback. Unsaved text is not persisted across a page reload.

## What feedback does

Each result has an immutable source/output snapshot in
`classifier_result_snapshots`, linked to its original `classification_runs`
row. Corrections append to `classifier_feedback`, including category, title,
summary, issue, explanation, actor, timestamp, and version. A transaction updates
the display projection and appends feedback together. Database constraints and
triggers protect the original snapshot and correction history.

Corrections are saved for a later improvement pass; they do **not** retrain the
model, alter other results, become evaluation gold labels, or count as approval.
Individual discovery URLs and evidence spans remain part of the original
prediction; describe problems with those fields in the explanation. A future
improvement pass can group recurring mistakes and use appropriate examples,
after accounting for overlap with existing evaluation data.

The advanced **Manual workspace** remains available for the earlier draft and
approved-reader workflow; see [its runbook](manual-review-local.md). Export and
approved-reader behavior remains separate. Plan 015 adds automatic local intake
under [ADR 0008](decisions/0008-local-automatic-feed.md). Automatic training and
hosted deployment remain outside this workflow. Historical evaluation results
are unchanged; this interface makes no new classifier quality claim.

## API and checks

- `GET /v1/classifier-results`: 20 results per page. Optional `filter` is `all`,
  `discovery`, `expert_note`, `skipped`, `uncertain`, or `corrected`. Follow
  `next_cursor` with the same filter. Filtering uses the latest correction.
- `GET /v1/classifier-results/:id`: display values, original prediction, bounded
  source, model metadata, and correction history. The ID is a classifier run UUID.
- `POST /v1/classifier-results/:id/corrections`: shared
  [feedback contract](../packages/contracts/src/classifier-feedback-v1.ts) with
  `expected_version`, `command_key`, `category`, `title`, `summary`, `issue`, and
  `explanation`. The server supplies the actor. Exact retries return the original
  version; stale versions and conflicting command reuse return HTTP 409.

All endpoints require the local bearer token. While the local servers are
running, `npm run classifier-results:smoke` reads the feed and opens result,
source, and correction screens without submitting feedback. Screenshots land
in ignored `output/playwright/`. Integration and browser correction tests use
the disposable `hn_manual_review_test` database; the
[test instructions](manual-review-local.md#tests-without-touching-demo-data)
also cover migration, concurrency, and session recovery checks.
