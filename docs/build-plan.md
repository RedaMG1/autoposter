# Auto-poster: build plan

Design: `docs/autoposter-design.md`. Each phase ends with something you can open and use.
Everything runs locally first (`wrangler dev` with local D1/R2), so no account is needed until deploy.

## Stack
- `app/`: one Cloudflare Worker that serves the PWA (static assets) and the API on the same origin.
  - API: TypeScript + Hono. D1 (SQLite) for data, R2 for videos, Cron Trigger every 5 min.
  - PWA: Vite + Preact + TypeScript, `vite-plugin-pwa` (installable, offline shell).
  - Tests: Vitest with `@cloudflare/vitest-pool-workers` (real D1/R2 in tests).
- `pc-worker/`: Python 3.13 (the one with CUDA + the clipper), pytest.
- Uploads skip the Worker (100 MB request limit): the API hands out presigned R2 URLs
  and the PC uploads the full-quality mp4 straight to R2.
- Auth: Cloudflare Access in front of the app (your email only). The PC worker uses a
  separate secret token (`Authorization: Bearer ...`), accepted only on `/api/worker/*`.

## Data (D1)
- `clips`: id, streamer, title, caption_tiktok, caption_instagram, yt_title, hashtags, video_key,
  thumb_key, duration, score, source_vod, status (waiting | approved | skipped), created_at
- `posts`: id, clip_id, platform (instagram | tiktok | youtube), scheduled_at, status
  (scheduled | posting | posted | failed), remote_id, remote_url, error, attempts
- `jobs`: id, twitch_url, status (queued | running | done | failed), progress, log, created_at
- `accounts`: platform, display_name, encrypted tokens, expires_at
- `settings`: slots per day (default 12:00, 17:00, 21:00 Europe/Paris), auto-schedule on approve

## Phase 1: app shell, library, import (no posting yet)
1. Repo: git init, `app/` with wrangler config (D1 `DB`, R2 `MEDIA`, cron), Hono, `/api/health` + test.
2. D1 migration for the tables above + test.
3. API: list/get/patch clips, approve/skip, presigned upload URL, thumbnails. Tests for each.
4. PWA: Library (grid of clips, video preview, edit captions, approve/skip), installable manifest.
5. Calendar: approved clips get the next free slot, never the same streamer twice in a row;
   move or remove a slot. Tests for the slot logic.
6. `pc-worker/import_existing.py`: uploads the 40 clips on the Desktop + their post texts.
7. Check: open the app on PC and phone (local network), approve a few clips, see the calendar.

## Phase 2: deploy + Instagram (public)
1. You: Cloudflare account, `wrangler login` (opens your browser), Access rule for your email.
2. Deploy, create D1/R2, run migrations, R2 public-read link for Instagram pulls.
3. Accounts page: Meta OAuth (Instagram via Facebook Login), token storage (encrypted), refresh.
4. Cron publisher: due posts → Instagram Reels container → wait for processing → publish.
   Retries, error shown in History. Tests with a mocked Graph API.
5. Check: one real Reel posts at its slot.

## Phase 3: YouTube + TikTok (private until review)
1. Google OAuth + YouTube Shorts upload (resumable). If Worker limits get in the way, the
   PC worker does YouTube uploads. Quota guard: max 6 per day.
2. TikTok OAuth + Content Posting API (pull from URL with a verified domain, else chunked upload).
3. Privacy policy + terms pages, review application texts for TikTok and Google.
4. Check: one test post on each (private).

## Phase 4: PC worker makes clips
1. Job loop: polls `/api/worker/jobs`, reports progress, runs prepare + chat spikes.
2. Claude API picks moments (spikes.md + chunks → moments.json), check, render.
3. Claude reviews contact sheets, applies the known fixes (silent lead-in, muted VOD,
   wrong facecam, unsafe content filter), uploads, creates clips as "waiting".
4. Windows auto-start for the worker (Task Scheduler), PWA "New clips" page with progress.
5. Check: paste a Twitch link on the phone, clips appear for approval.
