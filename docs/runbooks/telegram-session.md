# Telegram session runbook

The mtcute SQLite session is a credential. It belongs only on the operator's
machine and the Railway worker volume. It must never enter Git, an environment
variable, IaC, a Docker layer, a pre-deploy command, a log, or an API/scheduler
service.

## Create or validate locally

The root `.env` is gitignored. Configure `TELEGRAM_API_ID`,
`TELEGRAM_API_HASH`, `TELEGRAM_SESSION_PATH=.sessions/telegram.session`, and
the intended `TELEGRAM_SOURCE_KEY`. Do not put a phone number, login code, 2FA
password, or serialized session in `.env`.

Build and run the interactive initializer from a private terminal:

```sh
umask 077
npm run build
npm run telegram:session:init
```

The command uses mtcute's persistent SQLite storage, refuses non-interactive
input, hides the login code and 2FA password, destroys the client cleanly, sets the session
file to mode `0600`, and emits only `telegram_session_ready`. Re-running it
validates and reuses an already-authorized session without printing its owner.

After the client closes, verify locally that there is one non-empty session
file and no `-wal`, `-shm`, or journal file. Never display or checksum the file
in shared logs. The repository ignores `.sessions/`, `*.session`, and
`*.session-journal`.

Before upload, run the bounded 100-ID contract from the operator machine:

```sh
node --env-file=.env scripts/run-contract-tests.mjs --target telegram
```

This contacts Telegram. Stop if the range, source account, or source channel is
not the approved one.

## Bootstrap an empty Railway volume

This is a remote mutation and requires staging approval. The volume must
already be attached only to `worker` at `/data/telegram`; volumes are not
mounted during Railway pre-deploy commands.

1. Keep the worker stopped and `TELEGRAM_ENABLED=false`.
2. Resolve the exact staging volume ID with
   `railway volume --environment staging list --json`.
3. Upload the closed local file under a new remote filename:

   ```sh
   railway volume --environment staging files --volume <volume-id> upload .sessions/telegram.session /telegram.session --json
   ```

4. List only file metadata with
   `railway volume --environment staging files --volume <volume-id> list / --json`.
   Do not download or print the file.
5. Set the worker path to `/data/telegram/telegram.session`, confirm the API and
   scheduler lack Telegram keys, then deploy one worker.
6. With Telegram still disabled, restart the worker and confirm the file
   persists. Then request separate approval to enable Telegram.
7. Enable it only for the bounded staging contract/range. Confirm
   `worker_started`, `worker_heartbeat`, successful bounded jobs, and no
   interactive login prompt or credential/content log.

If mtcute creates a journal during use, it stays on the same volume. Never copy
a live SQLite database; stop the worker and allow clean client destruction
before downloading or replacing session state.

## Routine rotation

1. Create a second session locally at a new gitignored path and pass the bounded
   contract.
2. Stop the staging worker and upload it under a new remote filename.
3. Point `TELEGRAM_SESSION_PATH` to the new file through a reviewed variable/IaC
   change, deploy, and pass the bounded check.
4. Repeat in production only after explicit production approval.
5. Revoke the old authorization from Telegram's official active-sessions UI.
6. After the rollback window, delete the exact old remote file with explicit
   confirmation. Record only its filename and rotation date, never its content.

For a suspected compromise, revoke the old Telegram authorization first, keep
live ingestion disabled, then create a replacement. Also rotate the API ID/hash
if Telegram's security guidance or the incident scope requires it.

## Failure handling

- **Interactive login on every restart:** stop the worker; the volume/path is
  wrong or the file is invalid. Do not re-authenticate inside a Railway shell.
- **SQLite locked/corrupt:** stop every worker replica, preserve the file, and
  restore a known-good closed session or rotate it. Never run multiple worker
  replicas against one mtcute session.
- **Flood wait above ceiling:** leave the job deferred and reduce/bound the
  range. Do not bypass the configured wait ceiling.
- **Session missing:** keep `TELEGRAM_ENABLED=false`; do not allow jobs to
  terminally fail while attempting ad-hoc login.

Current persistence status: **NOT TESTED — the staging volume is mounted and
`READY`, but no session has been uploaded and restart persistence has not been
authorized or verified**.
