// Cron publisher: every few minutes, move due posts forward one step.
// Videos live on the PC: the PC poster starts uploads (see /api/worker/*); this cron checks
// processing and publishes (Instagram), checks status (TikTok), and times out stuck posts.
import { finalCaption } from "./captions";
import { decryptJson, encryptJson, sign } from "./crypto";
import type { Env } from "./env";
import * as ig from "./instagram";
import * as tt from "./tiktok";
import * as yt from "./youtube";

type Fetch = typeof fetch;
const MAX_ATTEMPTS = 3;
const PROCESSING_TIMEOUT_MS = 60 * 60_000;
export const DRAFT_ONLY = "not on your profile: TikTok only accepted it as an inbox draft until it approves the app. Retry once approved, or post it by hand (copy caption)";

export const PLATFORM_NAME = { instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube" } as const;

export interface PostRow {
  id: string; clip_id: string; platform: "instagram" | "tiktok" | "youtube"; scheduled_at: string;
  status: string; remote_id: string | null; attempts: number;
  title: string; streamer: string; caption_instagram: string; caption_tiktok: string; source_vod: string | null; tt_settings?: string | null; duration?: number | null;
  video_key: string | null; local_path: string | null; posting_started_at: string | null;
}

export const POST_ROW_SQL = `SELECT p.*, c.title, c.streamer, c.caption_instagram, c.caption_tiktok, c.source_vod, c.video_key, c.local_path, c.tt_settings, c.duration
  FROM posts p JOIN clips c ON c.id = p.clip_id`;

/** Signed, time-limited public link so a platform can download a video (R2 mode only). */
export async function publicMediaUrl(env: Env, key: string, ttlMs = 2 * 3600_000, now = Date.now()): Promise<string> {
  const exp = String(Math.floor((now + ttlMs) / 1000));
  const sig = await sign(env.SESSION_KEY, `media:${key}:${exp}`);
  return `${env.PUBLIC_URL.replace(/\/$/, "")}/api/public/media/${key}?exp=${exp}&sig=${sig}`;
}

export async function loadTokens<T>(env: Env, platform: string): Promise<T | null> {
  const row = await env.DB.prepare("SELECT tokens FROM accounts WHERE platform = ?").bind(platform).first<{ tokens: string | null }>();
  return row?.tokens ? decryptJson<T>(env.TOKEN_KEY, row.tokens) : null;
}

export async function saveTokens(env: Env, platform: string, tokens: unknown) {
  await env.DB.prepare("UPDATE accounts SET tokens = ? WHERE platform = ?").bind(await encryptJson(env.TOKEN_KEY, tokens), platform).run();
}

/** Fresh YouTube / TikTok tokens (refreshed and saved when they expired). */
export async function ytTokens(env: Env, f: Fetch = fetch) {
  const t = await loadTokens<yt.YtTokens>(env, "youtube");
  if (!t) return null;
  const r = await yt.fresh(f, env.YT_CLIENT_ID!, env.YT_CLIENT_SECRET!, t);
  if (r.changed) await saveTokens(env, "youtube", r.tokens);
  return r.tokens;
}

export async function ttTokens(env: Env, f: Fetch = fetch) {
  const t = await loadTokens<tt.TtTokens>(env, "tiktok");
  if (!t) return null;
  const r = await tt.fresh(f, env.TT_CLIENT_KEY!, env.TT_CLIENT_SECRET!, t);
  if (r.changed) await saveTokens(env, "tiktok", r.tokens);
  return r.tokens;
}

async function fail(env: Env, id: string, error: string) {
  await env.DB.prepare("UPDATE posts SET status = 'failed', error = ? WHERE id = ?").bind(error.slice(0, 500), id).run();
}

/** A platform's daily upload cap (new YouTube channels get only a few uploads a day). */
export const DAILY_LIMIT = /exceeded the number of videos|uploadLimitExceeded|quotaExceeded|daily limit/i;

export async function retryOrFail(env: Env, p: Pick<PostRow, "id" | "attempts">, error: string, permanent: boolean) {
  if (DAILY_LIMIT.test(error)) {
    // not the post's fault: try again tomorrow, without using up its attempts
    const tomorrow = new Date(Date.now() + 24 * 3600_000).toISOString();
    await env.DB.prepare("UPDATE posts SET status = 'scheduled', scheduled_at = ?, error = ?, remote_id = NULL WHERE id = ?")
      .bind(tomorrow, "daily upload limit reached: trying again tomorrow", p.id).run();
    return;
  }
  const attempts = p.attempts + 1;
  if (permanent || attempts >= MAX_ATTEMPTS) return fail(env, p.id, error);
  // back to scheduled, tried again later: 15 min after the 1st failure, 30 after the 2nd (temporary platform errors pass)
  const later = new Date(Date.now() + attempts * 15 * 60_000).toISOString();
  await env.DB.prepare("UPDATE posts SET status = 'scheduled', attempts = ?, error = ?, remote_id = NULL, scheduled_at = ? WHERE id = ?")
    .bind(attempts, `retrying: ${error}`.slice(0, 500), later, p.id).run();
}

const isPermanent = (e: unknown) =>
  (e instanceof ig.IgError || e instanceof tt.TtError || e instanceof yt.YtError) && e.permanent;

async function connected(env: Env, platform: string) {
  return Boolean(await env.DB.prepare("SELECT 1 FROM accounts WHERE platform = ? AND tokens IS NOT NULL").bind(platform).first());
}

export async function runDue(env: Env, f: Fetch = fetch, now = Date.now()): Promise<{ started: number; finished: number; failed: number }> {
  const stats = { started: 0, finished: 0, failed: 0 };
  const rows = (await env.DB.prepare(
    `${POST_ROW_SQL} WHERE (p.status = 'scheduled' AND p.scheduled_at <= ?) OR p.status = 'posting'
     ORDER BY p.scheduled_at LIMIT 15`).bind(new Date(now).toISOString()).all<PostRow>()).results;

  for (const p of rows) {
    const name = PLATFORM_NAME[p.platform];
    if (!(await connected(env, p.platform))) {
      await fail(env, p.id, `${name} is not connected (Settings > Accounts).`); stats.failed++; continue;
    }
    if (!p.video_key && !p.local_path) { await fail(env, p.id, "This clip has no video file."); stats.failed++; continue; }
    // the video is on the PC: the PC poster starts the upload
    if (p.status === "scheduled" && !p.video_key) continue;
    if (p.status === "scheduled" && p.platform !== "instagram") continue; // only Instagram can pull from R2

    const stuck = p.posting_started_at && now - Date.parse(p.posting_started_at) > PROCESSING_TIMEOUT_MS;
    try {
      if (p.platform === "instagram") {
        const tokens = (await loadTokens<ig.IgTokens>(env, "instagram"))!;
        if (p.status === "scheduled") {
          const url = await publicMediaUrl(env, p.video_key!, 2 * 3600_000, now);
          const container = await ig.createReel(f, tokens, url, finalCaption("instagram", p));
          await env.DB.prepare("UPDATE posts SET status = 'posting', remote_id = ?, posting_started_at = ?, error = NULL WHERE id = ?")
            .bind(container, new Date(now).toISOString(), p.id).run();
          stats.started++;
          continue;
        }
        if (!p.remote_id) continue; // claimed, upload address not handed out yet
        const s = await ig.containerStatus(f, tokens, p.remote_id);
        if (s.status_code === "FINISHED") {
          const { mediaId, permalink } = await ig.publish(f, tokens, p.remote_id);
          await env.DB.prepare("UPDATE posts SET status = 'posted', remote_id = ?, remote_url = ?, error = NULL WHERE id = ?")
            .bind(mediaId, permalink, p.id).run();
          stats.finished++;
        } else if (s.status_code === "PUBLISHED") {
          await env.DB.prepare("UPDATE posts SET status = 'posted', error = NULL WHERE id = ?").bind(p.id).run();
          stats.finished++;
        } else if (s.status_code === "ERROR" || s.status_code === "EXPIRED") {
          await retryOrFail(env, p, `Instagram could not process the video: ${s.status ?? s.status_code}`, false); stats.failed++;
        } else if (stuck) {
          await retryOrFail(env, p, "Instagram took more than an hour to process the video", false); stats.failed++;
        }
      } else if (p.platform === "tiktok") {
        if (!p.remote_id) { if (stuck) { await retryOrFail(env, p, "the PC upload did not finish", false); stats.failed++; } continue; }
        const tokens = (await ttTokens(env, f))!;
        const s = await tt.status(f, tokens.access_token, p.remote_id);
        console.log("tiktok status", p.id, JSON.stringify(s));
        if (s.status === "SEND_TO_USER_INBOX") {
          // Only a draft: it is not on the profile. Leave it as not posted so it can be retried
          // once TikTok approves the app (then it posts directly).
          await env.DB.prepare("UPDATE posts SET status = 'failed', error = ? WHERE id = ?")
            .bind(DRAFT_ONLY, p.id).run();
          stats.finished++;
        } else if (s.status === "PUBLISH_COMPLETE") {
          const postId = s.publicaly_available_post_id?.[0];
          const acct = await env.DB.prepare("SELECT display_name FROM accounts WHERE platform = 'tiktok'").first<{ display_name: string }>();
          const user = acct?.display_name?.startsWith("@") ? acct.display_name : "";
          const url = postId && user ? `https://www.tiktok.com/${user}/video/${postId}` : user ? `https://www.tiktok.com/${user}` : null;
          await env.DB.prepare("UPDATE posts SET status = 'posted', remote_url = ?, error = ? WHERE id = ?")
            .bind(url, null, p.id).run();
          stats.finished++;
        } else if (s.status === "FAILED") {
          await retryOrFail(env, p, `TikTok could not publish: ${s.fail_reason ?? "unknown reason"}`, s.fail_reason === "spam_risk_too_many_posts"); stats.failed++;
        } else if (stuck) {
          await retryOrFail(env, p, "TikTok took more than an hour to process the video", false); stats.failed++;
        }
      } else if (stuck) {
        // YouTube is marked posted as soon as the PC finishes the upload; only time out here
        await retryOrFail(env, p, "the PC upload to YouTube did not finish", false); stats.failed++;
      }
    } catch (e) {
      await retryOrFail(env, p, (e as Error).message ?? String(e), isPermanent(e)); stats.failed++;
    }
  }
  return stats;
}

/** Instagram long-lived tokens (old login type) last 60 days; refresh when fewer than 10 are left. */
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
