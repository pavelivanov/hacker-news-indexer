# Telegram serialized-session runbook

`TELEGRAM_SESSION` is an mtcute-exported authorization credential. The worker
imports it into in-memory storage on every start and validates it with a
headless authorized call before processing jobs. No phone, login code, 2FA
password, local SQLite file, Railway file upload, or interactive production
login is part of the runtime path.

The session string still represents the Telegram user or bot that created it.
It removes interactive login from deployment; it does not make the integration
anonymous or independent of an authorized Telegram identity. Anyone who obtains
the string can act as that identity, so treat it as a password.

## Supply and validate locally

Obtain a serialized session from an approved mtcute-compatible source without
pasting it into chat or command-line arguments. A string exported by another
client format is not assumed compatible. Configure only the gitignored `.env`:

```dotenv
TELEGRAM_API_ID=...
TELEGRAM_API_HASH=...
TELEGRAM_SESSION=...
TELEGRAM_SOURCE_KEY=hn_best_comments
TELEGRAM_ENABLED=true
```

Then build and run the headless authorization check:

```sh
npm run build
npm run telegram:session:check
```

Success emits only `telegram_session_ready`; it never prints identity or session
data. The check imports the string into memory, calls `getMe` without logging its
result, and destroys the client. It must fail rather than request interactive
input when the string is missing, malformed, revoked, or unauthorized.

Before staging configuration, run the bounded 100-ID contract from the operator
machine:

```sh
node --env-file=.env scripts/run-contract-tests.mjs --target telegram
```

This contacts Telegram and must print only the test summary. Stop if the range
or source channel is not the approved one.

## Configure staging

This is a remote mutation and requires staging approval.

1. Keep `TELEGRAM_ENABLED=false` on the worker.
2. Add `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_SESSION`, and
   `TELEGRAM_SOURCE_KEY` to the staging worker through Railway's dashboard.
   Never place the values in IaC, CLI arguments, shell history, deployment
   notes, logs, or screenshots.
3. Seal `TELEGRAM_API_HASH` and `TELEGRAM_SESSION`. Treat the API ID as
   sensitive even though Telegram identifies it as an application identifier.
4. Read back variable names only. Confirm the API and scheduler contain no
   Telegram keys and that the worker contains all four names.
5. Deploy with Telegram still disabled and confirm normal worker heartbeat.
6. After separate enablement approval, set `TELEGRAM_ENABLED=true`. The worker
   must reach `SUCCESS`, validate the imported session without prompting, and
   emit its normal startup and heartbeat events without identity or session
   data.
7. Run one approved bounded ingestion range and confirm exact aggregate counts,
   retry behavior, HN resolution, and absence of source bodies or secrets in
   bounded logs.

The existing staging `telegram-session` volume predates this design and will no
longer be used after the serialized-session code deploys. Keep it attached until
the rollout and restart validation pass. Removing it is destructive and requires
a separate reviewed IaC plan and explicit approval.

## Rotation and revocation

1. Obtain a replacement mtcute session string from an approved identity.
2. Validate it locally with `telegram:session:check` and the bounded contract.
3. Keep ingestion paused or Telegram disabled while replacing the sealed worker
   variable through the Railway dashboard.
4. Redeploy one worker, verify headless authorization and the bounded contract,
   then resume ingestion.
5. Revoke the old authorization from Telegram's official active-sessions UI.

For a suspected compromise, disable Telegram ingestion and revoke the exposed
authorization first. Then rotate `TELEGRAM_SESSION`; rotate the API ID/hash too
when Telegram guidance or the incident scope requires it.

## Failure handling

- **Missing/malformed session:** keep Telegram disabled, replace the sealed
  value, and rerun the headless check. Never add an interactive Railway login.
- **`AUTH_KEY_UNREGISTERED`:** the session is unauthorized or revoked; obtain a
  new approved session and leave ingestion disabled.
- **Repeated reconnect/auth errors:** stop the worker, verify only variable
  presence and bounded error codes, then rotate the session if required.
- **Flood wait above ceiling:** leave the job deferred and reduce/bound the
  range. Do not bypass the configured ceiling.

Current status: **SERIALIZED-SESSION SUPPORT IMPLEMENTED LOCALLY; LIVE SESSION
VALIDATION, SEALED STAGING CONFIGURATION, BOUNDED INGESTION, AND LEGACY-VOLUME
REMOVAL REMAIN GATED.**
