# Plan 013: Deliver a local browser inbox for manual review

> **Executor instructions**: Read fully before changing code. Follow the steps
> and gates in order. Update `plans/README.md` only when the done criteria pass.
> Completed checkpoints are recorded in the milestone report linked below.
>
> **Drift check**: Run `git diff --stat b856e31..HEAD -- apps packages scripts tests package.json package-lock.json tsconfig.json eslint.config.js .github/workflows/ci.yml plans` and `git status --short`.
> Compare changed files against the current-state facts below. Preserve unrelated
> user work, including `.zcode/`. Resolve material contract drift before proceeding.

## Status

- **Priority**: P1
- **Effort**: L; six checkpoints below
- **Risk**: HIGH for approval/provenance changes; MED for the browser
- **Depends on**: existing Plan 004 review/materialization and Plan 005 reader implementations
- **Category**: direction / correctness / frontend
- **Planned at**: commit `b856e31`, 2026-09-04
- **Execution status**: DONE (local browser, draft/approval, and all verification gates passed)

## Completed implementation milestone — 2026-09-05

The owner requested **draft storage and approval**, then authorized the local
browser workspace. All six steps are complete. Backend, component, real-browser,
accessibility, evaluation, and container gates passed. A read-only browser pilot
opened five captured comments; approval tests used only synthetic sources in the
isolated test database. The local workspace is running with 98 captured comments.
See the [completion report](reports/013-manual-review-completion.md) for commands,
results, screenshots, implementation details, and remaining scope.

## Selected product scope

The owner selected a **Manual review MVP**, a **browser interface**, **both
Discoveries and Expert notes**, **editable drafts followed by explicit approval**,
**existing stored/captured comments**, and **local execution first**.

The complete journey: unlock the local app, open an existing comment, read its
evidence and root context, save an incomplete draft, return after reload, finish
it, approve it, and see retained content in the feed. An irrelevant comment can
instead receive an explicit rejected decision. A Discovery can include a
supporting Expert note, following `classification.v1`.

Implementation defaults, distinguished from owner selections: one owner, one
current draft per comment, explicit Save draft button, source-span selection
rather than arbitrary text highlighting, and an inbox plus two feed tabs.
Editing is supported before approval. Published-decision editing is deferred;
do not expose an Edit action that cannot complete safely.

## Why this matters

Review can approve an existing decision but cannot create the first human
decision for an unclassified comment. The normal application also lacks a path
from a new decision to materialized Discoveries and Expert notes. A browser over
the present task list would therefore leave the stored corpus largely unusable.
This plan closes the human-to-feed path.

The classifier remains disabled. v1 failed its model holdout; v2 and v3 failed
annotation agreement before model selection. ADR 0006's terminal assist-only
decision remains in force. This plan does not reopen evaluation or imply that
the classifier passed.

## Current state and conventions

Paths are relative to `/Users/p/Projects/hacker-news-indexer`. These facts were
checked directly at the planning commit.

- `packages/db/src/repositories/classification.ts:325` rejects a first manual decision:

  ```ts
  if (
    input.classificationRunId !== null ||
    input.manualOverrideOfId === null
  ) {
    throw new TypeError(
      "A manual decision requires an overridden decision and no run",
    );
  }
  ```

  `packages/db/prisma/migrations/0003_classification/migration.sql:50` enforces
  the same restriction in `content_decisions_source_check`. Extend both layers
  through a forward migration. Never invent a model run to satisfy them.
- `packages/application/src/classification/load-input.ts:12` rebuilds bounded
  selected-comment/root documents and URL candidates. Reuse this evidence
  catalog and `validateClassifierOutput` without a provider. `span:<n>` and
  `url:<n>` refer to one input snapshot, not durable source identities.
- `packages/contracts/src/classification-v1.ts` requires complete, consistent
  output. Incomplete form JSON must use a separate draft contract and must never
  become `ContentDecision.validatedOutput`.
- `packages/application/src/subjects/materialize-classification.ts:364`
  exports `createMaterializeClassification`. It validates output/evidence,
  applies subject identity rules, writes pending items, and can open URL/merge
  tasks. Its manual branch does not pin the entire input hash: the new manual
  workflow must pin and revalidate its source snapshot.
- `packages/db/src/repositories/review.ts:622` approves existing pending items
  and switches the active decision. It does not create missing items. Its
  rejection action preserves the previous active decision; rejecting a proposal
  is different from recording that a comment is irrelevant.
- Classification, subject materialization, and review repositories start their
  own transactions. Sequential calls do not form an atomic approval. Subjects
  already has a private `runMaterialization(transaction, input)` helper to reuse.
- `packages/db/prisma/migrations/0005_review/migration.sql` requires an approved
  review task/audit event before activation and checks reason codes. Preserve
  these protections; add a manual reason instead of reusing an unpromoted-model reason.
- `apps/api/src/app.ts` composes injected services and protects `/v1/*` with
  bearer auth. Match `routes/review.ts`'s strict handling and
  `tests/unit/review-route.test.ts`'s injected-service tests.
- Reader endpoints are `/v1/feed?kind=discovery`, `/v1/feed?kind=expert_note`, and
  `/v1/comments/:id`. Reuse their contracts and publication policies.
- `packages/db/src/repositories/hn-resolution.ts:30` initially stores root
  `textPlain=null`. The input loader normalizes root HTML, but reader evidence
  uses `root.textPlain` at `repositories/reader.ts:268` and `:338`. Empty excerpts
  are dropped and can hide an approved root-body-only item. Correct this narrow
  normalization mismatch as part of the real feed journey.
- `apps/api/src/server.ts:11` binds `0.0.0.0`. Local API and Vite must explicitly
  bind to `127.0.0.1`.
- `apps/web` is absent. Root unit tests include only `tests/unit/**/*.test.ts`;
  new component tests need explicit runner wiring. ESLint needs TSX coverage.
- `Dockerfile` explicitly copies each workspace manifest before `npm ci`, then
  runs the root build. The new web workspace must not break the backend image.
- `npm run seed:replay` imports checked fixture sources without a provider.
  Do not use `seed:materialize-shadow`, whose model/gold-derived decisions would
  invalidate the proof of creating a first human decision.
- `scripts/reset-test-db.mjs` drops the public schema without a target allowlist.
  Integration tests also truncate tables. Neither may target the persistent demo.

## Scope boundaries

**In scope — modify only as required:**

- New `packages/contracts/src/manual-review-v1.ts`,
  `packages/domain/src/manual-review.ts`, `packages/ports/src/manual-review.ts`,
  `packages/application/src/manual-review/`, and
  `packages/db/src/repositories/manual-review.ts`.
- A new DB transaction-context helper and narrow transaction reuse changes to
  `packages/db/src/repositories/{classification,subjects,review}.ts`.
- `packages/db/src/repositories/reader.ts`, `scripts/audit-feed.mts`, and
  `tests/integration/reader.test.ts` only for root-body normalization parity and
  its dependency wiring; no pagination or publication-policy redesign.
- `packages/db/prisma/schema.prisma`, new
  `packages/db/prisma/migrations/0008_manual_review/migration.sql`,
  `packages/domain/src/review.ts`, necessary shared repository types/package exports.
- `apps/api/src/{app,server}.ts`, new `apps/api/src/routes/manual-review.ts`,
  `packages/config/src/env.ts`, and affected config tests/redaction allowlists.
- New `apps/web/`; root manifests/lockfile, browser test configs,
  TypeScript/ESLint build wiring, `.gitignore`, `.github/workflows/ci.yml`, and
  minimal `Dockerfile` workspace/build compatibility changes.
- New `scripts/manual-review/`, `docs/manual-review-local.md`,
  `apps/web/README.md`, and root README links.
- Tests listed below and minimal updates to affected existing tests.
- This plan, `plans/README.md`, and Plan 008's overlap note.

**Out of scope:** provider calls, prompts, promotion, new evaluation cycles,
worker/queue repair, live intake, pasted-URL ingestion, external-page fetching,
export approval/delivery, Railway changes, hosted auth, subject-merge UI, full
story/subject browsing, published-decision editing, and unrelated pagination fixes.
Import existing classification validation helpers without modifying classifier
application files for this feature.

Use branch `codex/013-local-manual-review-mvp` for execution, preserving unrelated
work. Do not push, deploy, or change the owner's branch as part of this handoff.

Never hand-edit sealed `evaluation/cycles/`, `evaluation/annotations/`,
`evaluation/captures/`, or non-fixture reports. Do not modify captured seed
fixtures/gold labels. Run operational scripts through their root npm aliases.

## Contract and persistence decisions

### Drafts and inbox

Use a bounded, versioned draft format permitting missing fields while rejecting
unknown properties, excessive strings/arrays, and invalid enum/ID shapes. Store
it separately from content decisions: UUID, comment ID, payload, optimistic
version, actor/timestamps, source-input hash, availability/revision fingerprint,
base active-decision ID, and terminal outcome/decision ID. Drafts never change
the active pointer or produce feed items. No credentials/provider metadata.

Query selected comments directly, including those with no run or review task.
Provide `unreviewed`, `draft`, `approved`, `rejected`, and `all` inbox filters;
page size 20 with stable `(firstSeenAt, id)` keyset ordering. Include filter and
version in a validated cursor. Apply eligibility before the limit. Unresolved,
deleted, and flagged **existing selected-comment rows** remain visible with a
reason but cannot be approved. Resolution failures that never created a
selected-comment row are excluded: a provenance/failed-ingestion inbox is deferred.

Maintain one current draft per comment. Repeated creation returns it. Save uses
`expected_version`; stale saves return 409 and preserve the stored revision and
unsaved browser text. For changed source snapshots, provide explicit rebase:
preserve free text, discard old evidence/URL selections, require re-selection,
and increment the version. Never silently bind old IDs to new passages.

### Atomic finalization

The complete form produces `ClassificationV1`, checked by the existing schema
and grounding validator. Reviewers choose confidence, described as their judgment
rather than measured accuracy. Preserve taxonomy/origin rules: Discovery may have
a supporting note; rejected output has no retained extraction.

New decisions use `source=MANUAL`, no classification run, `reviewRequired=true`,
and a persisted link to the finalized draft revision. Override ID is null only
when the snapshot's base active-decision ID is null, regardless of inactive model
history; otherwise use that same-comment active ID. No arbitrary inactive decision
may be chosen as the predecessor. The initial workflow disallows editing an
already published decision, while legacy repository override callers remain valid.
Keep model constraints and historical manual overrides valid. Add
`MANUAL_DECISION_REVIEW` to domain/application policy at score 25 and the DB
reason allowlist. Do not add this application-owned reason to the model schema.

The persisted states are `DRAFT`, `APPROVED`, and `REJECTED`; finalization is
atomic, so there is no durable half-finished approval state. Terminal drafts are
read-only. Creating/saving/rebasing a draft for an already reviewed comment
returns the terminal state or a 409; it must not become a hidden editing route.

**Final approval uses one database transaction.** Introduce a narrow unit-of-work
port whose callback receives repositories bound to one transaction. Keep Prisma
types in `packages/db`. Extract/reuse required existing repository operations;
ordinary callers retain their interfaces/transaction behavior. Bound factories
must not open nested transactions, retry individual inner writes, or use the
global client. Retry serialization conflicts at the outer boundary, at most
three attempts. No network/provider/file operations inside the transaction.

Inside it: check command receipt; load/lock draft and relevant selected-comment/
root records; check draft version, complete source fingerprint, availability,
and base active pointer; revalidate output; save decision/evidence; materialize
pending retained items; open required review/audit records; approve through the
shared review operation; finalize draft; save receipt. Roll everything back on
failure. Fingerprinting covers root text/title/URL and candidate ordering, not
just comment text. Protect source checks with locking/serialization and prove
concurrent source updates cannot publish stale evidence.

A unique command key plus canonical request hash makes exact retries return
the committed result, including after a lost response. Same key/different body
returns 409. Concurrent keys for one draft revision yield one decision and one
terminal approval event. After serialization failure, check receipts in a new
transaction, never an already aborted transaction.

Generic review endpoints must not finalize/reopen workflow-owned manual
decisions without these checks. Enforce this in the shared service/repository
boundary. An internal transaction-bound finalization context can authorize the
review operation; no client-provided flag may do so. Test direct route attempts.

“Reject comment” finalizes a validated MANUAL/REJECTED decision through the same
audit/activation protections, with a required reason and no retained items. Do
not implement it with the existing proposal-rejection action alone. Retained
content requires a separate explicit Approve action after saving.

Select URLs only from the source catalog. Preserve canonical URL/subject policies
and additional URL/merge tasks. Expose warnings/status rather than auto-merging
or inventing URLs. Preserve reader/export eligibility independently from content
approval. Cases that cannot pass policy remain actionable drafts with a reason;
never report publication when the reader hides the result. Prove the basic
Discovery journey using an unambiguous grounded URL. Advanced merge/export UI
remains deferred.

### HTTP surface

Existing bearer auth protects every route; actor identity comes from server
configuration, not request JSON. Share strict request/response contracts.

| Route | Behavior |
|---|---|
| `GET /v1/manual-review/inbox?state=unreviewed&cursor=…` | Paged source/draft state |
| `GET /v1/manual-review/comments/:id` | Bounded evidence/root, URL catalog, draft, fingerprint |
| `POST /v1/manual-review/comments/:id/draft` | Create or return current draft |
| `PUT /v1/manual-review/drafts/:id` | Save partial payload with version/hash |
| `POST /v1/manual-review/drafts/:id/rebase` | Explicit new snapshot; clear stale selections |
| `POST /v1/manual-review/drafts/:id/approve` | Atomically approve saved retained draft revision |
| `POST /v1/manual-review/drafts/:id/reject` | Finalize rejection with version/key/reason |

Use 400 for malformed input, 401 for auth, 404 for missing entities, 409 for
state/version/source/idempotency conflicts, and 422 with bounded field errors
for incomplete/ungrounded final output. Sanitize internal errors. Return IDs,
state, and replay status. Confirm feed visibility through the reader API.

## Steps and verification

Run commands at repository root with pinned Node 24. Aliases explicitly called
new below must be added; they do not exist at the baseline. All destructive DB
checks require `DATABASE_URL` explicitly set to disposable `hn_manual_review_test`.
Never use default DB fallbacks for tests.

### Step 1: Define contracts and validation

Implement draft/domain/port contracts and error types. Keep raw form payloads
distinct from validated output. Reuse normalizers, catalogs, and validators.
Document required fields per class. Add
`tests/unit/manual-review/{contracts,validation}.test.ts`: incomplete drafts;
unknown fields/bounds; valid note/discovery/both/rejection; invalid spans/URLs;
root/comment mismatch; confidence range; unchanged model contract.

**Verify:** `npm test -- tests/unit/manual-review/contracts.test.ts tests/unit/manual-review/validation.test.ts` and `npm run typecheck` exit 0.

### Step 2: Add persistence and shared transactions

Add the forward migration, draft/receipt tables, initial manual-decision support,
and transaction-bound repositories. Implement draft creation/save/rebase/inbox
and finalization prerequisites. Preserve existing audited behavior and do not
backfill invented decisions. Use `tests/integration/review-workflow.test.ts` as
a test pattern, with the isolated target below.

Add new `manual-review:prepare-local` and `manual-review:prepare-test` npm aliases
backed by `scripts/manual-review/`. Create local databases `hn_manual_review`
and `hn_manual_review_test` if absent; never reset/drop an existing DB. Reject
remote hosts or mismatched names. Use the existing loopback Compose PostgreSQL
service without altering its volume. Write ignored, owner-readable demo/test
environment files with explicit DB targets and distinct generated local API
tokens. Do not reuse hosted tokens or print credentials. Use
`npm run db:migrate:deploy`; only demo preparation runs `npm run seed:replay`.
Keep classifier/Telegram disabled and do not start workers. Repeat preparation
must preserve demo drafts and approvals.

Add new `manual-review:check-test-target`, which rejects missing `DATABASE_URL`,
the demo DB, remote hosts, and other names. Run this guard before reset/truncating
tests. Document selecting the generated test environment without exposing secrets.

**Verify:** `docker compose up -d postgres`, `npm run manual-review:prepare-test`,
then in the explicit test environment `npm run manual-review:check-test-target`,
`npm run db:validate`, `npm run db:test:reset`, and `npm run db:migrate:deploy`
exit 0. Run `npm run test:integration -- tests/integration/manual-review-repository.test.ts tests/integration/classification-repository.test.ts tests/integration/review-workflow.test.ts`.
Cover clean migration, upgrade over existing model/manual rows, source constraints,
concurrent saves, and rollback. Confirm the demo DB is untouched.

### Step 3: Connect the complete API approval path

Implement the application service with the transaction port, materializer, and
shared review operations. Inject it through `createApp`. Add routes/error mapping.
No provider dependency and no new worker job. Add
`tests/unit/manual-review/{service,routes}.test.ts`,
`tests/integration/manual-review-workflow.test.ts`, and
`tests/contract/manual-review.test.ts`. Keep contract tests deterministic and
respect existing runner target filtering/dry-run behavior.

Correct root-body reader evidence by injecting a canonical-root-text function
into `createKnowledgeReaderRepository`. At the API, feed-audit script, and reader
integration-test composition sites, supply the existing `normalizeHnCommentHtml`
normalizer with a hasher. Derive the root body from the same current `textHtml`
as `loadClassifierInput`, not from a missing/stale `textPlain` cache. Keep the DB
package independent of the application package: pass the function, do not import
application code into DB or write a second HTML normalizer. Preserve root-title
and comment offset handling. Normalize once per root per repository request.

The decisive integration test starts with one source, **zero runs and zero
decisions**. Save partial draft: both feeds stay empty. Approve complete draft:
assert MANUAL decision, exact evidence, required review/audit, active pointer,
and a nonempty real reader response. Cover note, Discovery, Discovery plus note,
and rejection separately.

Also cover inactive MODEL history with no active pointer: the manual decision
has a null override and creates no new run. Include a replay-shaped root story
with nonempty HTML and null `textPlain`; select only its body evidence, approve,
and verify the actual feed excerpt and source offsets. Include stale non-null
`textPlain` to prove reader/input normalization parity rather than a null-only fix.

Inject failures after decision creation, materialization, and review approval:
each leaves the draft editable and no partial decision/feed/audit writes. Test
exact retry, key/body collision, two-tab approval, concurrent source edits or
deletion, root-only changes, generic-route bypass, and policy warnings. Assert
zero classification runs and provider calls.

**Verify:** `npm test -- tests/unit/manual-review`,
`npm run test:integration -- tests/integration/manual-review-workflow.test.ts`,
and `npm run test:contract -- --dry-run` pass. Live external tests may skip;
new manual contract tests may not. Pass the DB guard before integration.
Also run `npm run test:integration -- tests/integration/reader.test.ts` after
changing root normalization; existing reader assertions must still pass.

### Step 4: Build the browser workspace

Create Vite/React/TypeScript/Tailwind/shadcn in `apps/web`, fetching current setup
docs at execution time. Use frontend/accessibility skills if available. Give
browser TypeScript a separate suitable config instead of inheriting NodeNext
unchanged. Add new `dev:web`, `build:web`, `test:web`, `test:e2e:web`, and
`test:a11y:web` aliases. Include browser typecheck/build and TSX lint in root
checks without recursive scripts. Ensure component tests are actually discovered.
Adjust Dockerfile manifest copies/build inputs for the new workspace and lockfile
so the existing backend image still builds. Keep the final image's API/worker
entrypoints unchanged; no web server or deployment is added to that image.

Use a restrained inbox list beside readable source and editing panes. Stack on
narrow screens with Back navigation. Distinguish comment evidence from root
context, show truncation/availability/provenance, and render canonical text/code
safely. No raw HTML/provider output. Use readable typography, one accent,
visible focus, labels, and status text independent of color; no metric-card grid.

The form selects class, fields, passages, and candidate URLs. Save remains
available when incomplete; Approve explains missing requirements. Show saved/
unsaved states, preserve text on errors, and never silently overwrite a 409.
Unsaved changes require save or explicit discard before navigation; approval
uses only the saved revision. Explain evidence resets during rebase. Successful
approval opens actual reader content; rejection returns to the inbox.

Keep bearer auth in memory only; clear on 401/reload/logout and clear the password
input after unlock. No credentials in storage, URLs, Vite variables, built assets,
logs, or screenshots. Drafts persist on the API and return after re-unlocking.
Use relative `/v1` requests.

Configure Vite with `server.host: "127.0.0.1"`, fixed strict port, and a `/v1`
proxy to the local API without secret injection. Current primary documentation,
retrieved through Context7 on 2026-09-04, confirms this configuration:
[Vite server options](https://github.com/vitejs/vite/blob/main/docs/config/server-options.md).
Keep host checks/CORS protections. Add API `HOST` configuration with existing
`0.0.0.0` default preserved; local startup explicitly chooses loopback.

**Verify:** `npm run test:web`, `npm run typecheck`, `npm run lint`, and
`npm run build:web` pass. Component tests cover auth clearing, incomplete saves,
conflicts/rebase, safe rendering, finalization errors, and empty/populated feeds.
Review desktop/mobile screenshots and keyboard-only editing/approval.

### Step 5: Prove browser-to-database operation and local startup

Add new `dev:manual-review`, loading the dedicated demo environment, checking its
target/disabled flags, and starting only API/Vite on loopback. Cleanly stop both
children; refuse port conflicts rather than connecting to unrelated services.
Document preparation, unlock, startup/shutdown, data location, and recovery in
`docs/manual-review-local.md`.

Browser E2E uses the guarded test database, synthetic source fixtures under
`tests/fixtures/manual-review/`, and a real API. Do not mock approval/feed or use
gold decisions to prefill them. Fail unexpected external HTTP requests. Cover
save → reload/unlock → approve → nonempty feed, rejection, 409 recovery,
duplicate submit, and missing/expired auth. Separate E2E from the persistent
demo and serialize tests sharing the test DB.

**Verify:** repeated `npm run manual-review:prepare-local` preserves reviews;
`npm run dev:manual-review` exposes only loopback listeners.
`npm run test:e2e:web` passes with zero provider requests/runs.
`npm run test:a11y:web` reports no serious/critical violations; verify keyboard
unlock, evidence selection, draft save, and approval.

### Step 6: Complete gates and record evidence

Run the entire **Global verification gate** in `plans/README.md` with the guarded
test target selected. Do not duplicate/weaken that block. Stop local app processes
before its Compose shutdown. Also run `npm run test:contract -- --dry-run`,
`npm run test:evaluation`, `npm run evaluation:validate-cycles`,
`npm run test:web`, `npm run test:e2e:web`, and `npm run test:a11y:web`.
Recreate the test DB service after the global gate's Compose shutdown before
browser tests require it.

The evaluation wrapper is an existing fixture workflow: no paid run or changed
sealed states. Record expected generated fixture changes separately and
investigate unexplained evidence drift. Wire deterministic manual/web checks
into CI. Configure its disposable PostgreSQL database and `DATABASE_URL` as
`hn_manual_review_test`, consistent with the guard, and run migration/guard before
integration or browser setup. Record versions, commands, totals/skips, visual review, and limitations
in `plans/reports/013-manual-review-completion.md`. Only then mark Plan 013 DONE;
Plan 008 remains TODO for broader deferred work.

**Verify:** all commands exit 0; `git diff --check` passes; status shows only
expected artifacts, with no unintended sealed-evidence/seed changes. Demonstrate
the real nonempty-feed journey. Component-only green checks do not satisfy it.

## Done criteria

- [x] First manual decision succeeds without an existing run/decision.
- [x] Partial drafts persist and return through the API; drafts never appear in the feed.
- [x] Note, Discovery, supporting-note, and rejection journeys pass against real DB/API.
- [x] Approval is atomic/idempotent with source/version/availability conflict tests.
- [x] Generic review cannot bypass manual workflow guards.
- [x] Evidence/URLs retain exact snapshot provenance.
- [x] Root-body-only evidence remains visible after approval on replay-shaped sources.
- [x] Classifier stays disabled; manual workflow creates zero runs/provider calls.
- [x] Demo data is isolated from destructive tests and survives repeat preparation.
- [x] Partial drafts survive browser reload/unlock and the complete editing journey.
- [x] Browser credentials stay in memory; local API/web bind to loopback.
- [x] Global, integration, contract, evaluation, browser, accessibility gates pass.
- [x] Runbook, completion evidence, and plan status match actual results.

## STOP conditions

- Material contract drift or another implementation of this workflow: reconcile
  before duplicating work.
- Unknown/remote/production/demo DB selected for destructive tests: correct the
  target before proceeding.
- Approval cannot keep evidence, materialization, audit, and activation in one
  transaction: report the specific boundary rather than accept partial writes.
- Required journey demands a provider call, new cycle, unsafe evidence/URL
  bypass, secret in frontend, or unrequested deployment.
- Existing URL/subject policy prevents the agreed journey without more scope:
  report the concrete case and smallest extension; do not weaken policy silently.

## Maintenance notes

Future model suggestions should populate drafts and retain explicit approval.
Source changes must preserve snapshot/rebase rules. Published-decision editing
needs new immutable revisions and reader/export reconciliation, not in-place
updates. Scrutinize transaction reuse when changing repository retries. Plan 008
can extend this workspace with subject/story/merge views and separately authorized
hosting.
