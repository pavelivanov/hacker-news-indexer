# Automatic updates and recovery

The local workspace fetches new selected Hacker News comments, classifies them,
and shows the results without a human verification or approval step. Corrections
remain optional and are saved for later improvements.

## Start and use

Follow the [results setup](classifier-results-local.md#start-locally). The root
`.env` needs `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_SESSION`,
`CLASSIFIER_PROVIDER=openai`, `CLASSIFIER_MODEL`, and `CLASSIFIER_API_TOKEN`.
`TELEGRAM_SOURCE_KEY` defaults to `hn_best_comments`. The session must already be
authorized to read that channel. This workflow does not perform Telegram login.
Optional `CLASSIFIER_REASONING_EFFORT` defaults to `low`.

`npm run dev:manual-review` starts the API, browser server, and one feed worker
against the isolated loopback `hn_manual_review` database. Provider and Telegram
credentials reach the worker only; the browser receives neither. Existing local
environment files retain `CLASSIFIER_ENABLED=false` and `TELEGRAM_ENABLED=false`
for the legacy runtime; the dedicated feed worker is started explicitly by the
supervisor. Test mode uses synthetic adapters and never starts live intake.

Open [Classifier results](http://127.0.0.1:5173/?view=results). Unlock with the
local API token from `.env.manual-review.local`.

- **Sync now** requests a bounded source check once pending work finishes.
- **Processing details** shows last check, latest result, queued/failed work,
  daily usage, and the next UTC reset.
- **Pause updates** persists across restarts. The current item may finish;
  further jobs and checks wait for **Resume updates**.
- **Show new results** refreshes the list when results arrive. Polling does not
  replace the open result or discard an unsaved correction.
- **Retry** requeues a failed job. A failed result's **Retry processing** uses
  its saved source input. Earlier predictions and corrections remain available.
  An interrupted response offers an exact retry without creating duplicate jobs.

The worker runs while the local workspace is running. Closing the browser alone
does not stop it; Ctrl-C in the supervisor does. A sleeping/stopped computer
cannot ingest content. Durable queued jobs resume on restart, including expired
leases after a crash. One session lock prevents a second worker or the older
captured-comment generator from running concurrently.

## Bounds and provenance

Defaults are stored in `feed_processing_state`: checks every 1,800 seconds,
20 selection IDs per batch, and 100 classifier requests per UTC day. There is no
browser settings editor for these limits in this milestone.

The first sync starts at the newest 20 Telegram message IDs, rather than loading
the entire channel history. Subsequent batches continue after the saved cursor,
never beyond the latest observed message. Deleted/nonselection messages can
produce fewer results. The cursor advances only after successful range ingestion;
failed ingestion blocks later ranges until recovered. Classification of already
ingested comments may continue independently of other failed comments.

Each actual provider dispatch reserves a request first, including output-validation
retries. The daily allowance is a request cap, not a dollar cap; request costs
depend on the model and input size. A reservation can be consumed without a
provider response during cancellation or a crash, so the counter is conservative.
Exhausted work waits until the next UTC day. Changing days does not start a new
process; the running worker resumes eligible jobs automatically.

Inputs are persisted before dispatch and reused after interruption. A stored run
is reused after a lost completion without another provider call. A process crash
after the provider accepted a request but before the response was stored can
still require another request; exactly-once provider billing is not guaranteed.
Stored retries get distinct attempt identities. No retry overwrites a previous
prediction or feedback, and new attempts do not automatically inherit corrections.

## Recover failures

Transient processing failures retry automatically, with a maximum of three job
attempts. Once exhausted, they appear under Processing details. Invalid output
that still fails after the classifier's validation retry is also visible.
Use **Retry** after the cause is resolved; it gets a fresh attempt allowance.

Authentication/configuration failures stop new classifier dispatches. Correct
the root `.env` and restart the workspace. Source connection failures retry after
one minute and leave the ingestion cursor unchanged. If source sync exhausts its
job retries, use **Retry sync**. Previously saved results remain readable.

An old failed result's retry is one durable job. Repeating that result action
returns the same job. If that job later fails, retry it under Processing details.
If the configured model has changed, the old result's first retry reports that
change; retry the job to explicitly use the current configured model.

An offline indicator means no recent worker heartbeat. Start/restart the local
workspace and check its terminal if it immediately exits. A different source
channel requires an explicit cursor/data migration; startup rejects silently
reusing one channel's cursor for another.

## API and verification

All endpoints require the existing local bearer token:

- `GET /v1/processing`: bounded status and the ten most recent failed jobs.
- `POST /v1/processing/control`: `{ "action": "sync" | "pause" | "resume" }`.
- `POST /v1/processing/jobs/:id/retry` and
  `POST /v1/processing/results/:id/retry`: `{ "command_key": "unique-key" }`.
  Exact retries recover the original receipt; conflicting reuse returns 409.

The [test instructions](manual-review-local.md#tests-without-touching-demo-data)
use `hn_manual_review_test`. The suite covers cursor boundaries, pause/resume,
queue isolation, atomic request limits, immutable retries, lost responses,
restart recovery, and migration upgrades. Run `npm run classifier-results:smoke`
against the running local workspace for a read-only browser check. Screenshots
are written to ignored `output/playwright/`.
`npm run feed:status` reads local database status and aggregate counts without
requiring the browser server, changing data, or exposing credentials.

This milestone does not change prompts, promote the classifier, retrain from
feedback, modify evaluation evidence, export results, or deploy hosted services.
