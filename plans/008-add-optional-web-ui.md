# Plan 008: Add the optional Vite/React reader and review UI

> **Executor instructions**: This is optional and not on the backend v1 critical path. Complete Plan 005 first so API contracts are stable. Use current frontend, shadcn/ui, and React performance guidance at execution time.
>
> **Drift check (run first)**: verify Plan 005 is `DONE`; regenerate/read current API contracts and confirm there is still no `apps/web` implementation. Stop if auth or response contracts changed materially.

## Status

- **Priority**: P3
- **Effort**: L
- **Risk**: MED
- **Depends on**: `plans/005-implement-knowledge-feed.md`
- **Category**: frontend / UX
- **Planned at**: unborn repository with no `HEAD`, 2026-08-24

## Why this matters

The backend can be used through its API, but a focused reader makes technical notes, subjects, story clusters, provenance, and review practical for daily personal use. The UI must remain restrained and evidence-first rather than becoming a generic dashboard.

## Current state expected from dependencies

- Authenticated feed/comment/story/subject/review APIs and strict TypeScript contracts exist.
- No frontend implementation exists.
- Preferred stack: Vite, React, TypeScript, Tailwind CSS, shadcn/ui.
- The system is private/single-user; credentials must not be persisted in browser local storage.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Develop | `npm run dev:web` | Vite serves the app |
| Typecheck | `npm run typecheck` | web and backend pass |
| Unit/component | `npm test -- --run apps/web` | all pass |
| E2E | `npm run test:e2e:web` | reader and review journeys pass |
| Build | `npm run build:web` | production assets emitted |
| Accessibility | `npm run test:a11y:web` | no serious/critical violations |

## Suggested executor toolkit

- Use the `frontend-skill` for composition and visual hierarchy.
- Use the `shadcn` skill/CLI for components; do not recreate registry primitives manually.
- Use current React/Vite performance guidance and web-interface accessibility review before completion.
- Re-query current Vite, Tailwind CSS, and shadcn/ui installation docs at execution time rather than relying on old CLI flags.

## Scope

**In scope**:

- `apps/web` Vite/React/TypeScript application, `components.json`, Tailwind setup, semantic tokens.
- Typed API client generated/derived from `packages/contracts` without duplicating response types.
- Latest feed, Discoveries, Expert notes, subject detail, story cluster, provenance/evidence view, and review queue/actions.
- Responsive, keyboard-accessible states and component/E2E/accessibility tests.
- Optional separate Railway static/web service configuration after local acceptance.

**Out of scope**:

- Public signup/accounts, social features, personalization, voting/comments.
- Rich text editing, arbitrary HTML rendering, external-page previews.
- Storing API/review tokens in localStorage/sessionStorage or shipping them in the JS bundle.
- Replacing backend policy/validation in the browser.

## Git workflow

- Branch: `codex/008-optional-web-ui`.
- Commit shell/tokens, reader routes, review flows, and E2E/a11y separately.
- Do not publish/deploy without instruction.

## Steps

### Step 1: Initialize the workspace and design tokens

Create `apps/web` from the current Vite React TypeScript template within the existing npm workspace. Initialize shadcn/ui in `apps/web/components.json`; keep registry primitives in `src/components/ui` and utilities in `src/lib/utils.ts`.

Define semantic light/dark tokens for background, foreground, muted, border, accent, warning, destructive, evidence origin, and review state. Use one readable text face and one monospace face for code/IDs. Avoid generic card grids; the primary composition is a dense editorial reading column with contextual side information.

**Verify**: web build/typecheck passes; a component inventory page renders tokens and shadcn primitives with no duplicated hand-built primitives.

### Step 2: Implement secure private-session/API access

Prefer same-origin deployment/proxy and an HttpOnly session mechanism if the backend adds one. If only bearer auth exists, accept the token for the current browser session and keep it in memory only; never persist it or include it in URLs/logs/error monitoring. Handle 401 by clearing memory and returning to the unlock screen.

Generate/derive API types from `packages/contracts`. Centralize fetch, aborts, strict response validation, cursor handling, and safe errors.

**Verify**: tests prove tokens are absent from local/session storage, URLs, rendered DOM, and captured logs; invalid response shapes fail closed.

### Step 3: Build the evidence-first reader

Implement routes/views for Latest, Discoveries, Expert notes, Subject, Story cluster, and canonical Comment. Feed items emphasize title/summary, subject, note/discovery kind, evidence origin, root context, and review state. Provenance expands on demand and links only to validated HN/Telegram permalinks.

Render backend-sanitized HN HTML in a tightly isolated component with an additional browser-side safety test. Code blocks scroll horizontally; external links use safe attributes. Provide loading skeletons, empty states, retryable errors, and tombstone states.

**Verify**: component tests cover every state; E2E traverses feed → subject → note → evidence → root story; no unsafe link or raw classifier output renders.

### Step 4: Build review workflows

Create an efficient review queue with reason/priority filters and approve, reject, merge-subject, and resolve-URL dialogs. Always show selected-comment evidence, root-only indicators, confidence, URL origin, conflicts, and current entity version. Require an explicit bounded reason for risky actions and handle 409 stale versions by refetching rather than overwriting.

Do not expose FindThatProject approval unless Plan 006 is complete and its contract is enabled.

**Verify**: E2E covers approve/reject, stale conflict, merge suggestion, URL resolution, keyboard-only flow, and audit confirmation.

### Step 5: Validate accessibility, responsiveness, and performance

Ensure semantic headings/landmarks, focus visibility, keyboard dialogs, accessible status text beyond color, reduced-motion support, and responsive layouts. Virtualize only if measurement proves it necessary; cursor pagination should bound the DOM naturally.

Avoid large client libraries and accidental server-data duplication. Analyze the production bundle and lazy-load review-only UI if it materially reduces the initial reader bundle.

**Verify**: accessibility command reports no serious/critical issues; keyboard journeys pass; production bundle meets the budget recorded in `apps/web/README.md`; mobile/desktop visual snapshots are reviewed.

### Step 6: Add optional Railway web deployment

Only after local acceptance, add a separate web/static service to Railway IaC. Keep it independent from API/worker deploys, configure the API origin/same-origin proxy without secrets at build time, and set watch paths to `apps/web`, shared contracts, and UI dependencies.

**Verify**: staging web deploy serves the production build, authenticates without persistent tokens, reaches the private API through the approved topology, and does not redeploy backend services for UI-only changes.

## Test plan

- Typed API client strict parsing/auth redaction.
- Feed/subject/story/comment component state matrix.
- Safe HTML/link rendering and tombstones.
- Review mutation/stale-version E2E.
- Keyboard and automated accessibility checks.
- Responsive visual snapshots and production bundle analysis.
- Staging same-origin/session smoke.

## Done criteria

- [ ] Vite/React/TypeScript/Tailwind/shadcn workspace builds within npm monorepo.
- [ ] API contracts are shared, not redefined.
- [ ] Tokens are never persisted or bundled.
- [ ] Reader and review flows are evidence/provenance complete.
- [ ] Safe rendering, accessibility, E2E, and bundle gates pass.
- [ ] Optional Railway web service is isolated and verified if deployed.
- [ ] Plan 008 is `DONE`, or remains TODO without blocking backend v1.

## STOP conditions

- Backend Plan 005 contracts/auth are not stable.
- Secure browser auth would require embedding or persisting the private token.
- A UI requirement needs untrusted HTML or arbitrary external-page fetching.
- Current shadcn/Tailwind/Vite setup differs materially from the plan and has not been re-queried.
- Frontend deployment would expose private backend routes unintentionally.

## Maintenance notes

Keep the UI subordinate to backend contracts and policy. New classifier fields should not render automatically. Reviewers should scrutinize token handling, unsafe HTML, duplicated contract types, and generic visual clutter that obscures provenance.
