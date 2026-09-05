# Knowledge browser

A local browser for classifier results and optional corrections, with the
existing manual-review workspace and approved reader available separately.
Follow the [results runbook](../../docs/classifier-results-local.md) from the
repository root.

- `npm run dev:manual-review` starts API, Vite, and the local feed worker together.
  The servers bind to loopback; test mode never starts the external-call worker.
- `npm run build:web` builds static assets; root build also checks browser types.
- `npm run test:web` runs discovered React component tests under jsdom.
- `npm run test:e2e:web` exercises real API/PostgreSQL review journeys.
- `npm run test:a11y:web` checks keyboard operation and desktop/mobile accessibility.

React owns an in-memory authenticated session. API requests use relative `/v1`
paths through Vite's local proxy. No token is stored in a URL, browser storage,
Vite variable, or built asset. Workspace navigation is loaded after unlock.
Source/form state stays in the editor; committed revisions come from PostgreSQL.
The default results workspace reads immutable classifier snapshots and shows
the latest correction as its display projection. Its short dialog supports
optimistic version conflicts and exact retry of uncertain saves. Corrections
preserve original output and append feedback; they never create approval events.
The manual workspace remains accessible through navigation or `?view=inbox`.

The processing strip polls status every five seconds while the page is visible.
New arrivals offer a refresh button instead of replacing the open result or
unsaved correction. Sync, pause/resume, daily usage, and failed-job retries live
in this strip. Failed predictions also have a retry action in their detail view.
Retries preserve the original prediction and correction history. See the
[feed runbook](../../docs/daily-feed-local.md).

The form uses the shared draft/output contracts, and final validation remains
on the server. Application-service imports in the web API client are type-only.

The source pane selects catalog passages for one field at a time. Origin and
root-only metadata follow those selections. Finalization is unavailable while
writing is unsaved, source evidence is stale, or required fields are incomplete.
Network failures retain the exact approval command for a safe retry.

Components use the standard shadcn Radix registry with Tailwind v4 and a local
Geist font. The workspace uses its own browser TypeScript configuration. The
backend container builds this workspace without adding a web-server entrypoint.

Browser tests run serially, require the disposable database, and do not mock
correction persistence, approval, or reader publication. Lost-response tests
allow real writes to commit and then drop their responses. The authentication-
expiry test sends an invalid token to the real authentication middleware.
