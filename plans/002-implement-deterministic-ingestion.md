# Plan 002: Implement deterministic selection ingestion and HN resolution

> **Executor instructions**: Complete Plan 001 first. Follow this plan step by step and update Plan 002 in `plans/README.md` when all gates pass. Never place Telegram credentials or session contents in source, fixtures, logs, the database, or plan status text.
>
> **Drift check (run first)**: verify Plan 001 is `DONE`, run `npm ci && npm run typecheck`, and compare the live workspace names with Plan 001. Any missing package or failing baseline is a STOP condition.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `plans/001-establish-project-foundation.md`
- **Category**: feature / correctness / data
- **Planned at**: unborn repository with no `HEAD`, 2026-08-24

## Why this matters

Deterministic provenance is the system's foundation. This plan ingests a bounded Telegram selection window, resolves only each chosen HN comment's parent chain, reconstructs multipart provenance, and persists canonical HN content without ever reading siblings. Classification must not start until all 98 accessible seed comments resolve reproducibly.

## Current state expected from Plan 001

- npm workspaces, strict TypeScript, Hono API/worker shells, Prisma/PostgreSQL connectivity, Docker, and CI exist.
- No product tables, source adapters, or jobs exist.
- Seed facts: Telegram IDs `32847..32946`, 100 messages, 98 unique HN comments, 55 current roots, 57 displayed story references, two multipart comments (`49369163`, `49370357`), and five displayed/current-root mismatches.

## Commands you will need

Use the global gate plus:

| Purpose | Command | Expected on success |
|---|---|---|
| Clean migrations | `npm run db:test:reset && npm run db:migrate:deploy` | exit 0 from empty DB |
| Seed replay | `npm run seed:replay -- --fixture tests/fixtures/seed/window-32847-32946.json` | 100 occurrences, 98 comments, 55 roots |
| Ingestion tests | `npm test -- --run tests/unit/ingestion tests/unit/hn tests/unit/multipart` | all pass |
| DB integration | `npm run test:integration -- --run tests/integration/ingestion-pipeline.test.ts` | all pass |
| Optional live contracts | `npm run test:contract -- --source hn` | passes only when explicitly enabled |

## Suggested executor toolkit

- Use current docs for the MTProto client before coding. Preferred candidate: [`@mtcute/node`](https://github.com/mtcute/mtcute), whose current `getHistory`/`iterHistory` support `minId`, `maxId`, offsets, and limits, and whose `getMessages` supports exact IDs.
- Before install, run `npm view @mtcute/node version deprecated time --json`. Stop if deprecated, archived, or stale enough to invalidate the research decision.
- Do not use GramJS while its repository remains archived.
- Use the official [Telegram history method](https://core.telegram.org/method/messages.getHistory) and [HN API](https://github.com/HackerNews/API/blob/master/README.md) as protocol sources of truth.

## Scope

**In scope**:

- Domain and port modules under `packages/domain/src` and `packages/ports/src`.
- `packages/adapters/src/{telegram,hn,fixtures}`.
- `packages/application/src/{ingest,resolve-hn,reconstruct,normalize}`.
- `packages/db/prisma/schema.prisma`, migrations `0001_ingestion` and `0002_hn_resolution`, repositories, and PostgreSQL job queue.
- `apps/worker/src/jobs/{ingest,resolve}.ts` and worker dispatch.
- `apps/api/src/routes/ingestion.ts` and token authentication middleware.
- Seed capture/replay scripts and fixtures under `scripts` and `tests/fixtures`.
- Unit, integration, and opt-in contract tests for this pipeline.

**Out of scope**:

- Classifier calls, subjects, review, feed, export, frontend.
- Sibling HN comments or any use of `kids`.
- External-page fetches.
- Telegram Bot API backfill.
- Storing Telegram session material in PostgreSQL.

## Git workflow

- Branch: `codex/002-deterministic-ingestion`.
- Conventional commits by logical slice: schema, source adapters, resolver, fixture corpus.
- Do not push or deploy remotely unless instructed.

## Steps

### Step 1: Define domain contracts before adapters

Create typed entities/enums for ingestion runs, occurrences, Telegram messages/entities, HN references, HN items, resolution paths, selected comments, multipart groups/parts, availability states, and retry states. Define ports:

- `SelectionSource.readRange(request): AsyncIterable<SelectionOccurrenceInput>`;
- `HnItems.get(id): Promise<HnFetchResult>`;
- repositories for runs, occurrences, HN items, resolution, and multipart state;
- `Clock` and deterministic `Hasher`.

Use branded/string-safe IDs at boundaries; HN and Telegram IDs must not be silently interchangeable. All use cases accept ports rather than concrete clients.

**Verify**: `npm run typecheck && npm test -- --run tests/unit/domain-identities.test.ts` → invalid cross-ID use fails at compile-test level and identity/hash tests pass.

### Step 2: Add migrations 0001 and 0002 plus a PostgreSQL lease queue

Implement the research tables for ingestion and resolution, including all uniqueness constraints. Add `pipeline_jobs` because the architecture requires a database-backed worker. It must include type, payload JSON, idempotency key, state, attempts, available time, lease owner/expiry, last error code, timestamps, and a unique idempotency key.

Claim jobs transactionally with `FOR UPDATE SKIP LOCKED`; Prisma raw SQL must be isolated in `packages/db/src/job-queue.ts`, parameterized, and integration-tested. Expired leases return to availability. Terminal/retryable states are explicit.

Preserve both `displayed_story_id` and `resolved_root_id`. Store response/content hashes and the ordered resolution path. Telegram body snapshot must be nullable and cleared after canonical resolution under the ADR retention default.

**Verify**: reset/migrate a clean DB, run `npm run db:migrate:deploy` twice, and execute `tests/integration/job-queue.test.ts` with two concurrent claimers → each job is claimed once, expired lease is recoverable, duplicate idempotency key creates one row.

### Step 3: Implement token-protected ingestion control

Add constant-time bearer-token middleware for all `/v1` routes except health/readiness. Add `POST /v1/ingestion-runs` accepting a strict body with source, source key, `min_id`, and `max_id`; reject ranges over a configured maximum and require `min_id <= max_id`. The route creates an ingestion run and one idempotent `INGEST_SELECTION_RANGE` job, then returns 202 with the run ID.

Never return source bodies or credential diagnostics.

**Verify**: `npm test -- --run tests/unit/ingestion-route.test.ts` → missing/wrong token is 401, invalid range is 400, duplicate request produces the same logical run/job, valid request is 202.

### Step 4: Implement and contract-test Telegram selection ingestion

Use `@mtcute/node` behind `TelegramMtprotoSource`. Primary retrieval may use bounded `getHistory`/`iterHistory`, but reconcile the requested range through exact-ID `getMessages` so gaps and deletions are explicit. Confirm boundary semantics with a contract test; do not assume `minId`/`maxId` inclusivity.

Configuration belongs only to the worker: API ID, API hash, source username, and a session storage path outside the repository. Locally use a gitignored path. Production persistence is handled in Plan 007 with a Railway volume. Log only source key, ID range, counts, wait duration, and error codes.

Parse message ID, timestamp, edit timestamp, text hash, entities, HN links, and multipart marker. Extract link roles separately: `DISPLAYED_STORY_REFERENCE`, `SELECTED_COMMENT`, `INLINE_HN_REFERENCE`. The trailing HN item link is only a candidate until verified as a comment.

Honor Telegram flood-wait durations below the configured ceiling; defer longer waits. Use three retries with exponential backoff/jitter for timeouts and retryable server errors.

**Verify**: adapter tests with a fake MTProto client cover exact range, missing ID, edit, duplicate replay, flood wait, retry exhaustion, and entity parsing. An opt-in live contract for `32847..32946` returns exactly 100 IDs without logging bodies.

### Step 5: Implement the HN adapter and parent-chain resolver

Fetch only `https://hacker-news.firebaseio.com/v0/item/{id}.json`. Parse known fields while tolerating additional/optional fields. Implement 10-second timeout, three retries for timeout/429/5xx, and delayed confirmation for HTTP 200 `null`.

The resolver must:

- verify the selected item is a comment;
- follow only `parent` until a story/poll without parent;
- never inspect or request `kids`;
- reject cycles and depth over 64;
- use a per-run `Map<number, Promise<HnFetchResult>>` so concurrent requests for one ID single-flight;
- persist the full path, displayed reference, current root, fetched time, raw response hash, and normalized item.

Deleted/dead items are successful tombstone states, not transport failures.

**Verify**: unit tests cover top-level/nested chains, five known root mismatches, dead duplicate story, cycle, depth 65, `null` versus timeout, deletion/dead states, and single-flight. A request-spy assertion must show zero sibling requests and no access to `kids`.

### Step 6: Normalize canonical HN content and multipart provenance

Parse HN comment HTML into sanitized canonical HTML, normalized plain text, code/text blocks, and anchor candidates without fetching destinations. Permit only `http`/`https` candidates and deterministic HN permalinks. Do not treat Telegram auto-linkification as canonical; fixtures must include `AGENTS.md`, `OpenStreetMap.org`, and bare `crates.io` false positives.

Multipart grouping requires common selected-comment ID, compatible displayed reference, unique `1..N`, identical totals, and bounded message-ID/time distance. Compare normalized concatenated snapshots against HN text when complete. HN text remains canonical even for incomplete snapshots.

**Verify**: both seed multipart pairs reconstruct exactly; duplicate/missing/conflicting parts produce the expected state; HTML entity/paragraph/code/link tests pass; unsafe schemes are rejected.

### Step 7: Freeze and replay the seed regression corpus

Create deterministic, sanitized fixtures for the 100 Telegram occurrences and the 163 distinct HN items fetched by the research run. Preserve IDs, timestamps, entity/link structure, HN API fields, and content necessary for normalization/classification; never include Telegram credentials or session state.

Add a replay command that starts from an empty DB and asserts:

- 100 occurrences and no missing Telegram IDs;
- 98 canonical selected comments;
- 55 current roots and 57 displayed references;
- five displayed/current-root mismatches;
- two multipart groups/four parts;
- 163 unique HN item fetches after per-run cache;
- zero sibling requests.

If the original complete fixture data is unavailable, recapture it from the documented public pages/HN API and have the owner approve the resulting hashes before calling the corpus frozen.

**Verify**: run the seed replay command twice against the same DB → counts and hashes remain stable and no duplicate logical records appear.

### Step 8: Wire the worker pipeline and failure states

The worker claims `INGEST_SELECTION_RANGE`, creates occurrence records transactionally, enqueues idempotent `RESOLVE_HN_COMMENT` jobs, then resolves/normalizes each comment. Use bounded concurrency. Store error codes and summaries, not source bodies. Mark a run complete only when terminal counts reconcile; retryable jobs must not falsely complete the run.

**Verify**: `tests/integration/ingestion-pipeline.test.ts` covers success, partial retry, process restart after lease expiry, duplicate replay, and terminal missing source. The full global gate passes.

## Test plan

- Domain identity and hash tests.
- Telegram parsing/range/retry/flood-wait tests with fakes.
- HN resolver tests with a request spy; explicitly assert zero `kids`/sibling access.
- HTML/URL normalization and multipart matrix.
- PostgreSQL uniqueness, lease concurrency, retry, and idempotency.
- Frozen seed end-to-end replay.
- Live HN/Telegram contract suites disabled in normal CI and requiring explicit flags/secrets.

## Done criteria

- [ ] Migrations apply cleanly and idempotently from an empty database.
- [ ] Seed replay produces the exact research counts.
- [ ] Selected-comment identification and root resolution are 100% on accessible fixtures.
- [ ] Multipart reconstruction is 100% on complete fixtures.
- [ ] Missing versus retryable states are correct.
- [ ] Request log proves zero sibling HN requests.
- [ ] Replays do not duplicate occurrences, comments, jobs, or paths.
- [ ] No source bodies, sessions, or secrets appear in logs.
- [ ] Global verification gate passes and Plan 002 is marked `DONE`.

## STOP conditions

- Plan 001 is incomplete or its package/config contracts drifted.
- `@mtcute/node` is deprecated, archived, incompatible with Node 24, or fails bounded history/exact-ID/session tests.
- The full seed fixtures cannot be recovered or owner-approved; do not fabricate the missing corpus.
- Correct resolution appears to require sibling traversal or third-party HN archives.
- Session persistence would require committing or logging credentials.
- Any live contract test mutates Telegram state beyond normal read/session bookkeeping.

## Maintenance notes

The source adapters are replaceable ports. Keep Telegram/HN SDK types out of domain/application modules. Reviewers should scrutinize range boundaries, exact-ID reconciliation, queue lease SQL, retry state transitions, and any code that references `kids`.
