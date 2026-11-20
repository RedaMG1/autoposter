# Auto-poster: design (draft for approval)

Goal: paste a Twitch link → clips get made on your PC → you approve them on your phone or PC →
they post on their own to Instagram, TikTok and YouTube at full quality, through the official APIs.

## Decisions (from you)
- Hosted for free on the web, used from PC and phone (PWA).
- Clips are made by a worker program on your PC (needs the GPU). PC only has to be on while making clips.
- Official APIs for all three platforms; we apply for TikTok and YouTube review.
- Moments are picked by Claude through an Anthropic API key (same quality as in chat).

## Pieces

```
 phone / PC ──► PWA (Cloudflare Pages)
                  │
                  ▼
           API (Cloudflare Worker) ── D1 database (clips, posts, jobs, accounts)
             │         │  └── R2 storage (full-quality mp4 + thumbnails, 10 GB free)
             │         └── cron every 5 min ──► Instagram / TikTok / YouTube APIs
             ▼
   PC worker (Python, your PC) — polls for jobs, runs the clipper, uploads results
```

1. **PWA** (installable, works on phone): Library (clip previews, edit title/caption, approve/skip),
   Calendar (3 slots a day, drag to move), New clips (paste Twitch link, see progress), Accounts
   (connect Instagram/TikTok/YouTube), History (posted / failed with the reason).
   Protected with Cloudflare Access (free login wall, only your email gets in).
2. **API + scheduler** (Cloudflare Worker + D1 + R2, free tiers): stores everything, hands out
   upload links to the PC worker, and every 5 minutes posts what is due:
   - Instagram: Reels via the Graph API, video pulled from an R2 link. Public immediately.
     Needs Instagram set to Creator/Business, linked to a Facebook Page, and a Meta app in
     development mode with you as the admin (no review needed for your own account).
   - TikTok: Content Posting API, video pulled from URL. **Private (only you) until TikTok audits
     the app.** Pulling from URL needs a verified domain (cheap custom domain, about 10 €/year) or
     we fall back to chunked upload.
   - YouTube: Data API upload as a Short. **Private until Google verifies the app.** Quota allows
     about 6 uploads a day.
   - Never posts a clip you have not approved. Retries failures, shows errors in History.
3. **PC worker** (Python, reuses the clipper skills already installed): picks up a job, downloads
   audio + chat, finds spikes, asks Claude (API key) to pick and title the moments, checks cuts,
   renders, checks the contact sheets (Claude looks at them too), uploads mp4 + post texts to R2,
   and adds them to the Library as "waiting for approval". Includes the fixes we learned:
   silent lead-ins, muted VOD stretches, wrong facecam, slurs/nudity filter.

## Costs
- Hosting, database, storage, cron: free tiers (Cloudflare).
- Claude API: pay per use, roughly a few cents to under 1 $ per stream.
- Optional domain for TikTok pull uploads: ~10 €/year.

## What only you can do (I never handle your passwords)
- Create the Cloudflare, Meta developer, Google Cloud and TikTok developer accounts, and the
  Anthropic API key, and paste keys into the app's settings / Cloudflare secrets.
- Log in once per platform when the app asks to connect your accounts.
- Submit the TikTok and Google review forms (I prepare the texts, privacy policy and terms pages).

## Build order
1. Repo + PWA shell + API + D1/R2 on Cloudflare, Access login wall.
2. Library + approve + calendar, import the 40 existing clips.
3. Instagram posting (works publicly first).
4. YouTube and TikTok posting (private until review) + review applications.
5. PC worker: Twitch link → clips → Library.

## Risks
- TikTok / Google reviews can be slow or refused for "reposting other creators' content"; credit
  streamers in every caption and keep to streamers who allow clipping.
- Free Worker CPU limits: if streaming a YouTube upload through the Worker hits limits, the PC
  worker does YouTube uploads instead.
- Platform API rules change; History will show the exact error when they do.
