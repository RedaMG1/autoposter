# Autoposter

Approve your stream clips and let them post themselves to Instagram, TikTok and YouTube.
Design: `docs/autoposter-design.md` · Plan: `docs/build-plan.md`

## Run it on your PC (phase 1)

```bash
cd app
npm install
npm run db:migrate   # first time only: creates the local database
npm run dev          # builds the app and serves it on port 8787
```

- PC: http://localhost:8787
- Phone (same network): http://<your PC's local IP>:8787 (`ipconfig` shows it; allow Node through the Windows firewall if asked)

Local data (database + videos) lives in `app/.wrangler/state` and is not committed.

## Add clips

```bash
cd pc-worker
python import_existing.py              # every clip in Desktop/clips
python import_existing.py --only taxi  # just the ones matching "taxi"
```

Needs `pc-worker/.env` with `AUTOPOSTER_API` and `AUTOPOSTER_WORKER_TOKEN`
(same token as `WORKER_TOKEN` in `app/.dev.vars`). Both files are git-ignored.

## Tests

```bash
cd app && npm test && npm run typecheck
cd pc-worker && python -m pytest -q
```

## Status
- Phase 1 (library, approve/skip, captions, calendar, import): done, local only.
- Nothing is posted anywhere yet: publishers arrive in phase 2 (Instagram) and 3 (TikTok, YouTube).
