// Cron publisher: every few minutes, move due posts forward one step.
import { decryptJson, encryptJson, sign } from "./crypto";
import * as ig from "./instagram";
import type { Env } from "./env";

type Fetch = typeof fetch;
const MAX_ATTEMPTS = 3;
const PROCESSING_TIMEOUT_MS = 60 * 60_000;

interface PostRow {
  id: string; clip_id: string; platform: "instagram" | "tiktok" | "youtube"; scheduled_at: string;
  status: string; remote_id: string | null; attempts: number;
  caption_instagram: string; video_key: string | null; posting_started_at: string | null;
}

/** Signed, time-limited public link so a platform can download a video. */
export async function publicMediaUrl(env: Env, key: string, ttlMs = 2 * 3600_000, now = Date.now()): Promise<string> {
  const exp = String(Math.floor((now + ttlMs) / 1000));
  const sig = await sign(env.SESSION_KEY, `media:${key}:${exp}`);
  return `${env.PUBLIC_URL.replace(/\/$/, "")}/api/public/media/${key}?exp=${exp}&sig=${sig}`;
}

async function loadTokens<T>(env: Env, platform: string): Promise<T | null> {
  const row = await env.DB.prepare("SELECT tokens FROM accounts WHERE platform = ?").bind(platform).first<{ tokens: string | null }>();
  return row?.tokens ? decryptJson<T>(env.TOKEN_KEY, row.tokens) : null;
}

async function fail(env: Env, id: string, error: string) {
  await env.DB.prepare("UPDATE posts SET status = 'failed', error = ? WHERE id = ?").bind(error.slice(0, 500), id).run();
}

async function retryOrFail(env: Env, p: PostRow, error: string, permanent: boolean) {
  const attempts = p.attempts + 1;
  if (permanent || attempts >= MAX_ATTEMPTS) return fail(env, p.id, error);
  // back to scheduled, tried again on a later run
  await env.DB.prepare("UPDATE posts SET status = 'scheduled', attempts = ?, error = ?, remote_id = NULL WHERE id = ?")
    .bind(attempts, `retrying: ${error}`.slice(0, 500), p.id).run();
}

export async function runDue(env: Env, f: Fetch = fetch, now = Date.now()): Promise<{ started: number; finished: number; failed: number }> {
  const stats = { started: 0, finished: 0, failed: 0 };
  const rows = (await env.DB.prepare(
    `SELECT p.*, c.caption_instagram, c.video_key FROM posts p JOIN clips c ON c.id = p.clip_id
     WHERE (p.status = 'scheduled' AND p.scheduled_at <= ?) OR p.status = 'posting'
     ORDER BY p.scheduled_at LIMIT 10`).bind(new Date(now).toISOString()).all<PostRow>()).results;

  for (const p of rows) {
    if (p.platform !== "instagram") {
      // TikTok and YouTube publishers arrive in phase 3
      await fail(env, p.id, `${p.platform === "tiktok" ? "TikTok" : "YouTube"} posting is not set up yet. Turn it off in Settings or connect it when available.`);
      stats.failed++;
      continue;
    }
    const tokens = await loadTokens<ig.IgTokens>(env, "instagram");
    if (!tokens) { await fail(env, p.id, "Instagram is not connected (Settings > Accounts)."); stats.failed++; continue; }
    if (!p.video_key) { await fail(env, p.id, "This clip has no video uploaded."); stats.failed++; continue; }

    try {
      if (p.status === "scheduled") {
        const url = await publicMediaUrl(env, p.video_key, 2 * 3600_000, now);
        const container = await ig.createReel(f, tokens, url, p.caption_instagram);
        await env.DB.prepare("UPDATE posts SET status = 'posting', remote_id = ?, posting_started_at = ?, error = NULL WHERE id = ?")
          .bind(container, new Date(now).toISOString(), p.id).run();
        stats.started++;
        continue; // Instagram needs time to process; check on the next run
      }
      // status = posting: check processing, publish when ready
      const s = await ig.containerStatus(f, tokens, p.remote_id!);
      if (s.status_code === "FINISHED") {
        const { mediaId, permalink } = await ig.publish(f, tokens, p.remote_id!);
        await env.DB.prepare("UPDATE posts SET status = 'posted', remote_id = ?, remote_url = ?, error = NULL WHERE id = ?")
          .bind(mediaId, permalink, p.id).run();
        stats.finished++;
      } else if (s.status_code === "ERROR" || s.status_code === "EXPIRED") {
        await retryOrFail(env, p, `Instagram could not process the video: ${s.status ?? s.status_code}`, false);
        stats.failed++;
      } else if (p.posting_started_at && now - Date.parse(p.posting_started_at) > PROCESSING_TIMEOUT_MS) {
        await retryOrFail(env, p, "Instagram took more than an hour to process the video", false);
        stats.failed++;
      }
    } catch (e) {
      const err = e as ig.IgError;
      await retryOrFail(env, p, err.message ?? String(e), err instanceof ig.IgError && err.permanent);
      stats.failed++;
    }
  }
  return stats;
}

/** Long-lived Instagram tokens last 60 days; refresh when fewer than 10 are left. */
export async function refreshTokens(env: Env, f: Fetch = fetch, now = Date.now()) {
  const row = await env.DB.prepare("SELECT tokens, expires_at FROM accounts WHERE platform = 'instagram'")
    .first<{ tokens: string | null; expires_at: string | null }>();
  if (!row?.tokens || !row.expires_at || Date.parse(row.expires_at) - now > 10 * 86_400_000) return false;
  const t = await decryptJson<ig.IgTokens>(env.TOKEN_KEY, row.tokens);
  const r = await ig.refresh(f, t.access_token);
  await env.DB.prepare("UPDATE accounts SET tokens = ?, expires_at = ? WHERE platform = 'instagram'")
    .bind(await encryptJson(env.TOKEN_KEY, { ...t, access_token: r.access_token }), r.expires_at).run();
  return true;
}
