# Plan 013 — manual-review MVP completion

This report records the completed manual-review milestone. The owner's later
[Plan 014](014-classifier-results-completion.md) makes classifier results with
optional corrections the default browser flow; its runbook describes current use.

Date: 2026-09-05. Branch: `codex/013-local-manual-review-mvp`.
Baseline: `b856e31`. Scope: persistent draft storage and atomic approval,
followed by the authorized local browser workspace. The backend milestone was
verified first; this report also records the browser implementation and its
real API/database verification.

## Delivered behavior

- One persisted, versioned draft per selected comment. Partial nested forms
  remain separate from validated decisions and never appear in the feed.
- Authenticated inbox, evidence detail, create, save, rebase, approve, and reject
  endpoints. Actor identity comes from server configuration; requests cannot
  impersonate another reviewer. JSON bodies are bounded before parsing.
- Explicit approval of a saved revision creates a first MANUAL decision without
  a classification run or fabricated predecessor. Discoveries, Expert notes,
  supporting notes, and explicit rejected judgments use the existing taxonomy.
- A serializable transaction commits the decision, evidence, materialized
  content, review task/audit, active pointer, terminal draft, and receipt
  together. Injected failures at three stages leave no partial publication.
- Exact retries return the committed result. Changed command bodies conflict;
  competing approvals cannot create two decisions. Terminal drafts are immutable.
- Source hashes cover availability, comment/root revisions, bounded normalized
  evidence, and URL candidate order. Stale versions and changed/deleted sources
  block finalization. Explicit rebase preserves writing and clears selections.
- Generic content-review routes cannot bypass the workflow. Existing URL,
  subject, reader, and export policies continue to apply; finalization exposes
  materialization warnings.
- Reader root-body evidence uses the same HTML normalizer as the evidence
  catalog, including roots with missing or stale `textPlain` caches.
- A forward migration preserves legacy model/manual decisions. Dedicated local
  demo/test databases, generated local credentials, guarded test commands, and
  a read-only HTTP smoke command support local use.

- A responsive browser inbox, source pane, and draft editor, with separate
  Discovery and Expert-note feeds. Canonical source text, root context, offsets,
  truncation, availability, and catalog URLs remain visible during review.
- Incomplete writing can be saved and resumed after reload/unlock. Approval uses
  the saved revision; a partial draft created through the API must save any
  form-supplied defaults before approval. Class changes, supporting notes,
  evidence targets, relevance, confidence, and rejection are editable.
- Unsaved navigation requires an explicit discard. Version conflicts retain
  writing and expose the latest saved draft for comparison. Explicit rebase
  preserves text and clears old evidence/URL selections. A lost approval
  response retains the exact command for retry; duplicate clicks send one request.
- Successful approval displays content from the real reader. Empty or withheld
  reader results and materialization warnings are shown without claiming that
  hidden content was published.
- Bearer credentials remain in memory, with the password field cleared on
  submission and the session cleared on reload, lock, or 401. Startup binds
  API/Vite to loopback, refuses occupied ports, and stops both processes together.

The [local runbook](../../docs/manual-review-local.md) includes startup, browser
instructions, endpoint bodies, error recovery, data location, and test isolation.

## Browser design and implementation

`apps/web` uses React 19.2.8, Vite 8.2.2, Tailwind 4.3.3, and the standard
shadcn/Radix registry. Setup and component guidance were fetched from current
primary documentation through Context7 and the registry CLI. The design uses
a quiet three-pane desktop layout, a stacked mobile layout, local Geist fonts,
one green accent, explicit labels, and visible keyboard focus. Source markup is
rendered as text rather than inserted as HTML. Reduced-motion preferences are
respected.

The browser has a separate Bundler-mode TypeScript configuration, discovered
component tests, TSX lint coverage, and root build/typecheck wiring. Shared
draft/output contracts validate the form; final grounding checks remain on the
server. Application-service DTO imports are type-only and do not pull database
code into browser assets. The workspace loads after unlock. Production output
is approximately 79 KB gzip for initial JavaScript, 74 KB for the workspace,
and 12 KB for CSS, plus locally bundled fonts.

The local supervisor passes only process essentials and public loopback ports
to Vite. Requests use relative `/v1` paths through its proxy. Credentials do not
enter Vite variables, browser storage, URLs, or screenshots. Browser test traces
and automatic failure screenshots are disabled; explicit screenshots are taken
after unlock or with an empty password field.

CI now runs deterministic manual contracts, components, real browser workflows,
and accessibility against the guarded disposable database. Docker includes the
new workspace manifest and build fixtures; the final image retains its existing
API/worker entrypoints and does not host the browser.

## Transaction implementation details

The classification, materialization, and review repositories reuse the exact
transaction supplied by the manual-review unit of work. An explicit WeakSet
identifies those clients: the installed Prisma runtime exposes `$transaction`
on transaction proxies, so checking only for that property would be incorrect.
Legacy callers retain their existing transaction behavior.

Serialization/uniqueness conflicts retry at the outer boundary, at most three
attempts. This includes Prisma P2034/P2002 and adapter-pg raw-query P2010 errors
whose nested PostgreSQL code is 40001 or 40P01. A retry starts a fresh transaction
and checks committed receipts; inner repositories never retry an aborted bound
transaction. Controlled concurrent-edit and duplicate-submission tests exercise
the actual installed adapter against PostgreSQL.

## Verification evidence

Host checks used Node 24.18.0, within the package's Node 24 engine range. The
repository pins 24.19.0 in its tool-version, CI, and container configuration;
that patch was unavailable on the host. Prisma is 7.9.1. Browser dependencies
were added with exact versions and a regenerated lockfile; comparison with the
baseline found no existing package version changes or removals. Playwright
1.63.0 used Chromium 153.0.8010.12 (build 1243); accessibility used axe 4.13.0.

| Check | Result |
| --- | --- |
| `npm ci` | Passed with the updated workspace lockfile |
| `npm run format:check` | Passed |
| `npm run lint` | Passed |
| `npm run typecheck` | Passed |
| `npm run build` | Passed |
| `npm test` | 278 passed across 38 files |
| `npm run test:web` | 10 passed across 3 files |
| Guarded `db:test:wait`, `db:validate`, `db:migrate:deploy` | Passed |
| Guarded clean `db:test:reset` then migration | All 10 migrations applied successfully |
| Guarded full `test:integration` | 67 passed across 12 files |
| `test:contract -- --dry-run` | 2 manual-review tests passed; 4 other/live tests skipped |
| `test:contract -- --target findthatproject --dry-run` | 2 FindThatProject tests passed; 4 non-target tests skipped |
| `test:evaluation` | 42 passed across 5 files; corpus/cycle checks and fixture benchmark/shadow completed |
| `evaluation:validate-cycles` | Passed; all 3 sealed cycle states unchanged |
| `npm run test:e2e:web` | 9 real API/PostgreSQL browser tests passed |
| `npm run test:a11y:web` | 1 keyboard/desktop/mobile scenario passed; no serious/critical violations |
| Local API preparation, startup, HTTP smoke, repeat preparation/smoke | Passed; 98 selected comments, required auth, valid evidence fingerprints |
| `manual-review:browser-smoke` | Opened 5 captured comments; 0 mutations, 0 browser storage entries; locking clears token |
| Local listener and occupied-port checks | API 3100 and Vite 5173 bound to `127.0.0.1`; second startup rejected without affecting them |
| `docker compose down` | Passed after browser test servers stopped |
| `docker build -t hn-knowledge:verify .` | Passed on Node 24.19.0; image `93590ea87d6d` |
| `git diff --check` | Passed |

Installation reported two dependency audit findings (one moderate, one high).
These were also reported before browser dependencies were added and were not
triaged as part of this feature. No forced dependency upgrades were applied.
The installed PostgreSQL driver also emitted a query-concurrency deprecation
warning during existing repository operations. It did not fail the checks;
future driver upgrades should account for it.

Database commands and integration tests ran through
`npm run manual-review:test -- <root-alias>` with the explicit generated
`hn_manual_review_test` environment. Clean migration reset only that disposable
database. The forward-upgrade test separately applies the historical migrations
in a temporary schema, inserts legacy decisions, applies the new migration, and
compares the stored rows. It removes that schema afterward.

The 22 new integration cases cover persisted incomplete drafts; all four outcomes
through the real API and reader; exact and conflicting retries; concurrent
creation/save/approval; root-only changes and deletion during finalization;
rollback after decision, materialization, and approval; inactive model history;
generic-review bypass; inbox pagination; and historical migration compatibility.
Root-body feed assertions cover both null and stale non-null `textPlain`.

Local setup replayed the checked captured source fixture into `hn_manual_review`.
The second preparation reported `created: false`, 98 selected comments, and
zero HN fetches. Both HTTP smoke runs made zero mutations. No captured comment
was approved on the owner's behalf. Approval/feed journeys used synthetic
fixtures only in the isolated test database.

## Browser verification and visual evidence

The nine E2E scenarios cover partial save → reload/unlock → approval → a
nonempty real note feed; Discovery; Discovery with supporting note; explicit
rejection; two-tab conflict recovery; source changes and rebase; a committed
approval with a dropped response; rapid duplicate approval; and unsaved
navigation plus a real authentication 401. Synthetic sources start with no
runs or decisions. Tests assert manual decisions, retained evidence, audit/feed
outcomes, and zero classification runs. Unexpected external browser requests
fail the tests; approval and reader responses are not mocked.

Component tests cover credential clearing, incomplete and API-created partial
drafts, conflict preservation, final validation failure, source markup safety,
and empty/populated reader results. The keyboard test unlocks, selects evidence,
saves, and approves. Desktop and 390-pixel mobile editor/feed scans have no
serious or critical axe violations and no horizontal overflow. An initial
selected-row contrast finding was corrected by darkening the muted text token;
the accessibility gate passed afterward. The captured-source pilot also exposed
source labels fading when selection was disabled before creating a draft. Source
text now remains fully opaque; the keyboard/accessibility test checks this state.
Accessibility, browser smoke, browser build, and container build passed again.

Screenshots were inspected for source/form readability, control alignment,
desktop composition, mobile stacking, and reader evidence display:

- [Desktop editor](../../output/playwright/editor-keyboard-desktop.png)
- [Mobile editor](../../output/playwright/review-mobile.png)
- [Published note](../../output/playwright/feed-desktop.png)
- [Unlock screen](../../output/playwright/unlock-desktop.png)
- [Captured-comment inbox](../../output/playwright/local-inbox.png)
- [Captured source before drafting](../../output/playwright/local-source.png)

Screenshots are local ignored artifacts, not committed fixtures.

After the global gate stopped PostgreSQL, local preparation restarted it and
again reported `created: false`, 98 selected comments, and zero HN fetches. The
HTTP check and browser pilot made zero mutations; no captured comment was
approved on the owner's behalf. Five source pages opened successfully, browser
storage stayed empty, and locking cleared the credential field. Listener
inspection confirmed only `127.0.0.1:3100` and `127.0.0.1:5173`; a second startup
correctly refused the occupied port. Browser test servers shut down cleanly.

## Remaining scope and operational state

- Editing published decisions, live intake, hosted deployment, and advanced
  subject/merge/export UI remain outside this milestone.
- Browser automation ran in Chromium; other browser engines have not been
  exercised. Existing reader pagination limitations remain deferred in the
  plan index. New browser checks are wired into CI but have only run locally
  because this branch has not been pushed.
- Changes are local and uncommitted. Plan 008 retains the broader deferred UI
  scope and must reuse this workspace.
- The local API, Vite workspace, and Compose PostgreSQL are running for owner
  use at completion. Open `http://127.0.0.1:5173` and unlock with `APP_API_TOKEN`
  from the ignored `.env.manual-review.local` file. Ctrl-C in the startup
  terminal stops both app servers; the runbook covers restarting them.
- The local workflow keeps classifier and Telegram disabled. It adds no provider
  dependency or worker job. No production configuration was changed.
- Sealed evaluation data and captured seed inputs have no working-tree changes.
  Terminal evaluation states remain v1 OPENED_FAILED and v2/v3 ANNOTATION_FAILED.
  Existing unrelated `.zcode/` content was left untouched.
