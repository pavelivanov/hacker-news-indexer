# HN Knowledge

A private collection of Hacker News discoveries and Expert notes. Browse
classifier results immediately and leave optional corrections during use.

The [classifier results runbook](docs/classifier-results-local.md) covers setup,
generation, browsing, corrections, and feedback storage. The
[automatic feed runbook](docs/daily-feed-local.md) covers updates and recovery. The advanced
[manual workspace](docs/manual-review-local.md) remains available.

```bash
npm ci
npm run build
docker compose up -d postgres
npm run manual-review:prepare-local
npm run dev:manual-review
```

Use Node 24. Open `http://127.0.0.1:5173` and unlock with the local token from
the generated `.env.manual-review.local` file. Automatic updates use the configured
Telegram and provider credentials in `.env`: every 30 minutes, up to 20 selection
IDs per sync and 100 classifier requests per UTC day. The browser provides sync,
pause/resume, and retry controls. Browsing results does not require approval. Saved corrections
update your view and remain available for later improvements, without automatic
model retraining.

See [implementation plans](plans/README.md) for project status and
[repository conventions](AGENTS.md) before changing source or evaluation data.
