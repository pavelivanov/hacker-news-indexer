# Local manual-review workspace

The default browser now opens **Classifier results**, with optional corrections
and no approval requirement. See the [results runbook](classifier-results-local.md).
This page documents the advanced **Manual workspace** retained from Plan 013.

The browser inbox, draft editor, approval, and reader feeds run against your
local PostgreSQL database. Plan 015 adds a dedicated automatic feed worker to
the shared supervisor; see [updates and recovery](daily-feed-local.md). The
advanced manual approval workflow below remains optional for private browsing.

## Prepare and start

Use Node 24 and run these commands from the repository root:

```bash
npm ci
npm run build
docker compose up -d postgres
npm run manual-review:prepare-local
npm run dev:manual-review
```

Open [the manual workspace](http://127.0.0.1:5173/?view=inbox). The browser server listens on
`127.0.0.1:5173` and the API on `127.0.0.1:3100`. Preparation creates the dedicated
`hn_manual_review` database and replays the existing captured source fixture.
Preparation preserves existing drafts and approvals on repeat runs and makes
no live source or classifier requests. Starting the supervisor enables the
bounded automatic feed using the configured root `.env` credentials.

The generated `.env.manual-review.local` file is ignored by Git and created
with owner-only permissions. It contains a fresh local `APP_API_TOKEN`, the
database target, and disabled classifier/Telegram flags. Supply that token as
the bearer Authorization header; do not put it in a URL. The owner identity
comes from `APP_REVIEW_ACTOR_ID` on the server. Production credentials are not
needed. An alternate local PostgreSQL server can be selected through
`MANUAL_REVIEW_ADMIN_URL`, whose database must be `postgres` on loopback.

Open `.env.manual-review.local` in your editor and copy the value of
`APP_API_TOKEN` into the browser's **Local API token** field. The password input
clears when submitted. Unlocking keeps the token in memory only; reload,
Lock, or an API 401 clears the session. Saved drafts remain in PostgreSQL.

While the API is running, `npm run manual-review:smoke` checks readiness,
authentication, inbox pagination, and source fingerprints without modifying data.
`npm run manual-review:browser-smoke` also opens up to five existing comments
through Chromium without creating drafts or decisions, verifies session clearing,
and saves local screenshots in `output/playwright/`.

Stop both servers and the feed worker with Ctrl-C. Startup refuses occupied ports and does not attach
to an unrelated service. `docker compose down` stops PostgreSQL while retaining
its volume. The demo database is separate from destructive integration tests.
`npm run dev:manual-review:api` remains available for API-only development.

## Browser review

1. Unlock, open **Manual workspace**, select an inbox comment, and choose **Start draft**. The filters show
   unreviewed comments, saved drafts, approved decisions, or rejected comments.
2. Choose **Expert note**, **Discovery**, or **Reject**. A Discovery can include
   a supporting note and up to five discoveries can share one decision.
3. Write the required fields. Choose the evidence target above the source, or
   use an evidence button in the editor, then select supporting passages.
   Comment passages and root-story context remain distinct. URLs come from
   the captured catalog. Raw source markup is rendered as text.
4. Use **Save draft** at any point. Incomplete drafts are allowed. Reload and
   unlock again to continue; the selected comment remains in the page URL.
5. Review the missing-field list, choose your confidence, save the finished
   revision, and enter an approval/rejection reason. **Approve saved draft**
   opens content returned by the actual reader. **Confirm rejection** records
   your judgment and returns to the inbox. URL/subject warnings may require
   further review before a retained item is visible.

Unsaved navigation opens a stay/discard choice. A version conflict preserves
your writing and lets you compare the latest saved draft, explicitly load it,
or carry your edits onto its version before saving. Source changes require
**Rebase evidence**; this preserves writing and clears old passages/URLs.
When an approval response is lost, **Retry saved approval** reuses the same
command. Editing pauses until the uncertain result is resolved.

On narrow screens, source and editor stack vertically. **Back to inbox** and
**Go to draft** provide navigation. All review controls support keyboard use.

## Draft and approval sequence

1. `GET /v1/manual-review/inbox` lists stored selected comments, including those
   with no classifier decision. Optional `state` values are `unreviewed`,
   `draft`, `approved`, `rejected`, and `all`; follow `next_cursor` with the same
   filter. Sources whose resolution never produced a selected-comment row are
   outside this inbox.
2. `GET /v1/manual-review/comments/:id` returns the current bounded evidence
   catalog, URL candidates, source hash, and saved draft. A false `available`
   value blocks finalization.
3. `POST /v1/manual-review/comments/:id/draft` with an empty body or `{}` creates
   one draft or returns the existing draft.
4. `PUT /v1/manual-review/drafts/:id` saves this body:

   ```json
   {
     "expected_version": 1,
     "source_hash": "<source_hash from the draft>",
     "payload": {
       "primary_decision": "EXPERT_NOTE",
       "expert_note": { "title": "Unfinished note" }
     }
   }
   ```

   The draft payload is a deeply partial `classification.v1` object. Unknown
   fields and invalid enums, IDs, or upper bounds are rejected. Missing fields,
   empty text, and empty evidence selections are allowed while drafting.
   Drafts never appear in the feed.

5. Finish and save the payload using
   [the classification contract](../packages/contracts/src/classification-v1.ts).
   A complete decision needs `schema_version`, `primary_decision`, reviewer
   `decision_confidence`, comment relevance/reason/evidence, rejection reasons,
   discoveries, optional expert note, and review flags/reasons. Each retained
   extraction needs its required fields, reviewer confidence, and grounded
   evidence. Discovery names must occur in cited spans. URL fields contain
   catalog IDs such as `url:0`, never arbitrary URLs. Review flags describe
   content risks; the server independently requires manual approval.
6. `POST /v1/manual-review/drafts/:id/approve` finalizes a saved Discovery or
   Expert note. A Discovery may have a supporting note. The request is:

   ```json
   {
     "expected_version": 2,
     "source_hash": "<source_hash from the saved draft>",
     "command_key": "review-unique-command-id",
     "reason": "Checked the claims against the cited source"
   }
   ```

   For an irrelevant comment, save a complete `REJECTED` payload with a taxonomy
   rejection reason and no retained extractions, then send the same command
   shape to `/reject`. This records an approved human judgment that the source
   is rejected; it is different from declining an existing model proposal.

7. Read the actual result through `/v1/feed?kind=discovery` or
   `/v1/feed?kind=expert_note`. Finalization returns the decision/review IDs,
   terminal draft, replay status, and URL/related-subject warnings. Existing
   subject/URL review and export policies remain independent; no export is sent.

Approval stores the immutable decision, evidence, materialized items, audit,
active pointer, terminal draft, and command receipt together. An error rolls
all of these back. Repeat exactly the same command after a lost response: the
server returns the original result. Reusing its key with another body fails.
Terminal drafts are read-only; editing published decisions is deferred.

## Conflicts and recovery

- `400 invalid_request`: fix the body, identifiers, query, or bounds.
- `401`: use the local API token.
- `404 not_found`: the comment or draft does not exist.
- `409 version_conflict`: reload the saved revision and reconcile edits.
- `409 source_conflict`: source evidence or availability changed. Inspect the
  new source, then POST `{ "expected_version": <current version> }` to
  `/v1/manual-review/drafts/:id/rebase`. Rebase keeps free text and clears every
  evidence/URL selection. Re-select evidence and save before approving.
- `409 state_conflict`: already finalized, or the active decision changed.
- `409 idempotency_conflict`: the command key was used for a different request.
- `422 output_invalid`: finish/correct the output using the returned validation
  code. The draft remains editable.
- `500 internal_error`: no partial approval is committed. Retry the same command
  when the underlying error is resolved; do not generate a new key for a lost response.

## Tests without touching demo data

```bash
npm run manual-review:prepare-test
npm run manual-review:test -- manual-review:check-test-target
npm run manual-review:test -- db:test:wait
npm run manual-review:test -- db:validate
npm run manual-review:test -- test:integration
npm test
npm run test:contract -- --dry-run
npm run test:web
```

`manual-review:test` loads `.env.manual-review.test`, verifies the explicit
loopback `hn_manual_review_test` target, and invokes the named root npm alias.
It refuses the demo database or an unexpected host/name. The integration suite
truncates test tables; run it serially against this dedicated target.

For a clean migration check, after verifying the target:

```bash
npm run manual-review:test -- db:test:reset
npm run manual-review:test -- db:migrate:deploy
npm run manual-review:test -- test:integration
```

The forward-migration regression also applies the historical migrations in a
temporary schema, inserts legacy model/manual decisions, upgrades, and checks
that those rows survive unchanged. The temporary schema is removed afterward.

For real browser and accessibility checks, install Chromium once, then use the
guarded root aliases:

```bash
npx playwright install chromium
npm run test:e2e:web
npm run test:a11y:web
```

These commands use `hn_manual_review_test`, start their own API/browser servers
on loopback ports 3101/5174, and refuse occupied test ports. Synthetic sources
replace data only in that disposable database. They create a fresh test token
for each run and block unexpected external browser requests. Traces, video,
and automatic screenshots are disabled to avoid capturing credentials. Explicit
screenshots of unlocked synthetic content are saved in ignored
`output/playwright/`. Do not run integration and browser suites concurrently
against the same test database.
