import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { encryptJson, safeEqual, sign, verify } from "./crypto";
import type { Env } from "./env";
import * as ig from "./instagram";
import { loadTokens, refreshTokens, retryOrFail, runDue, type PostRow } from "./publisher";
import { pickSlot, type Taken } from "./slots";

export type { Env } from "./env";
type App = { Bindings: Env };
const app = new Hono<App>();
const SESSION_DAYS = 30;

const PLATFORMS = ["instagram", "tiktok", "youtube"] as const;
const KEY_RE = /^clips\/[A-Za-z0-9_-]{1,64}\/(video\.mp4|thumb\.jpg)$/;
const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 16);

async function getSetting<T>(db: D1Database, key: string, fallback: T): Promise<T> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return row ? (JSON.parse(row.value) as T) : fallback;
}

// ---------- login ----------

app.get("/api/health", (c) => c.json({ ok: true }));

async function sessionValid(c: Context<App>): Promise<boolean> {
  const v = getCookie(c, "session");
  if (!v || !c.env.SESSION_KEY) return false;
  const [exp, sig] = v.split(".");
  return Number(exp) * 1000 > Date.now() && (await verify(c.env.SESSION_KEY, `session:${exp}`, sig ?? ""));
}

app.post("/api/login", async (c) => {
  const { password } = await c.req.json<{ password?: string }>().catch(() => ({ password: "" }));
  if (!c.env.APP_PASSWORD || !c.env.SESSION_KEY) return c.json({ error: "login is not set up on the server" }, 500);
  if (!password || !(await safeEqual(password, c.env.APP_PASSWORD))) {
    await new Promise((r) => setTimeout(r, 800)); // slow down guessing
    return c.json({ error: "wrong password" }, 401);
  }
  const exp = String(Math.floor(Date.now() / 1000) + SESSION_DAYS * 86_400);
  setCookie(c, "session", `${exp}.${await sign(c.env.SESSION_KEY, `session:${exp}`)}`, {
    httpOnly: true, secure: new URL(c.req.url).protocol === "https:", sameSite: "Lax", path: "/", maxAge: SESSION_DAYS * 86_400,
  });
  return c.json({ ok: true });
});

app.post("/api/logout", (c) => { deleteCookie(c, "session", { path: "/" }); return c.json({ ok: true }); });
app.get("/api/me", async (c) => c.json({ loggedIn: await sessionValid(c) }));

// Everything else under /api needs a login, except the PC worker API (own token)
// and signed video links (platforms download them without a login).
app.use("/api/*", async (c, next) => {
  const p = c.req.path;
  if (p.startsWith("/api/worker/") || p.startsWith("/api/public/")) return next();
  if (!(await sessionValid(c))) return c.json({ error: "not logged in" }, 401);
  return next();
});

// ---------- app API (needs login) ----------

app.get("/api/clips", async (c) => {
  const status = c.req.query("status");
  const q = status
    ? c.env.DB.prepare("SELECT * FROM clips WHERE status = ? ORDER BY score DESC, created_at DESC").bind(status)
    : c.env.DB.prepare("SELECT * FROM clips ORDER BY created_at DESC, score DESC");
  return c.json((await q.all()).results);
});

app.get("/api/clips/:id", async (c) => {
  const clip = await c.env.DB.prepare("SELECT * FROM clips WHERE id = ?").bind(c.req.param("id")).first();
  if (!clip) return c.json({ error: "not found" }, 404);
  const posts = await c.env.DB.prepare("SELECT * FROM posts WHERE clip_id = ? ORDER BY platform")
    .bind(c.req.param("id")).all();
  return c.json({ ...clip, posts: posts.results });
});

app.patch("/api/clips/:id", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const editable = ["title", "caption_tiktok", "caption_instagram"] as const;
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const k of editable) {
    if (typeof body[k] === "string") { sets.push(`${k} = ?`); vals.push((body[k] as string).trim()); }
  }
  if (!sets.length) return c.json({ error: "nothing to update" }, 400);
  const r = await c.env.DB.prepare(`UPDATE clips SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...vals, c.req.param("id")).run();
  if (!r.meta.changes) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});

/** Approve a clip and give it the next free slot on every enabled platform. */
app.post("/api/clips/:id/approve", async (c) => {
  const db = c.env.DB;
  const id = c.req.param("id");
  const clip = await db.prepare("SELECT id, streamer FROM clips WHERE id = ?").bind(id).first<{ id: string; streamer: string }>();
  if (!clip) return c.json({ error: "not found" }, 404);
  await db.prepare("UPDATE clips SET status = 'approved' WHERE id = ?").bind(id).run();

  const existing = await db.prepare("SELECT scheduled_at FROM posts WHERE clip_id = ? LIMIT 1").bind(id).first<{ scheduled_at: string }>();
  if (existing || !(await getSetting(db, "auto_schedule", true))) {
    return c.json({ ok: true, scheduled_at: existing?.scheduled_at ?? null });
  }
  const slots = await getSetting<string[]>(db, "slots", ["12:00", "17:00", "21:00"]);
  const platforms = await getSetting<string[]>(db, "platforms", [...PLATFORMS]);
  const taken = (await db.prepare(
    `SELECT DISTINCT p.scheduled_at AS at, c.streamer FROM posts p JOIN clips c ON c.id = p.clip_id
     WHERE p.status IN ('scheduled','posting')`).all<{ at: string; streamer: string }>()).results
    .map((r): Taken => ({ ts: Date.parse(r.at), streamer: r.streamer }));
  const ts = pickSlot(Date.now(), clip.streamer, taken, slots, c.env.TIMEZONE);
  const at = new Date(ts).toISOString();
  await db.batch(platforms.map((p) =>
    db.prepare("INSERT INTO posts (id, clip_id, platform, scheduled_at) VALUES (?, ?, ?, ?)").bind(newId(), id, p, at)));
  return c.json({ ok: true, scheduled_at: at });
});

app.post("/api/clips/:id/skip", async (c) => {
  const id = c.req.param("id");
  const r = await c.env.DB.prepare("UPDATE clips SET status = 'skipped' WHERE id = ?").bind(id).run();
  if (!r.meta.changes) return c.json({ error: "not found" }, 404);
  await c.env.DB.prepare("DELETE FROM posts WHERE clip_id = ? AND status IN ('scheduled','failed')").bind(id).run();
  return c.json({ ok: true });
});

/** Everything scheduled, plus the last 14 days of history. */
app.get("/api/calendar", async (c) => {
  const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
  const rows = await c.env.DB.prepare(
    `SELECT p.*, c.title, c.streamer, c.thumb_key FROM posts p JOIN clips c ON c.id = p.clip_id
     WHERE p.scheduled_at >= ? OR p.status IN ('scheduled','posting','failed')
     ORDER BY p.scheduled_at, p.platform`).bind(since).all();
  return c.json(rows.results);
});

/** Move all of a clip's unposted posts to another time. */
app.patch("/api/clips/:id/schedule", async (c) => {
  const { scheduled_at } = await c.req.json<{ scheduled_at: string }>();
  const ts = Date.parse(scheduled_at);
  if (Number.isNaN(ts)) return c.json({ error: "bad date" }, 400);
  if (ts < Date.now()) return c.json({ error: "that time is in the past" }, 400);
  await c.env.DB.prepare("UPDATE posts SET scheduled_at = ?, status = 'scheduled', error = NULL WHERE clip_id = ? AND status IN ('scheduled','failed')")
    .bind(new Date(ts).toISOString(), c.req.param("id")).run();
  return c.json({ ok: true });
});

app.delete("/api/posts/:id", async (c) => {
  const r = await c.env.DB.prepare("DELETE FROM posts WHERE id = ? AND status IN ('scheduled','failed')")
    .bind(c.req.param("id")).run();
  if (!r.meta.changes) return c.json({ error: "not found or already posted" }, 404);
  return c.json({ ok: true });
});

app.get("/api/settings", async (c) => {
  const rows = (await c.env.DB.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>()).results;
  return c.json(Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)])));
});

app.put("/api/settings", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const ok = (k: string, v: unknown) =>
    (k === "slots" && Array.isArray(v) && v.every((t) => typeof t === "string" && /^\d{2}:\d{2}$/.test(t))) ||
    (k === "platforms" && Array.isArray(v) && v.every((p) => (PLATFORMS as readonly string[]).includes(p as string))) ||
    (k === "auto_schedule" && typeof v === "boolean");
  const entries = Object.entries(body).filter(([k, v]) => ok(k, v));
  if (!entries.length) return c.json({ error: "nothing valid to save" }, 400);
  await c.env.DB.batch(entries.map(([k, v]) =>
    c.env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind(k, JSON.stringify(v))));
  return c.json({ ok: true });
});

// ---------- accounts ----------

app.get("/api/accounts", async (c) => {
  const rows = (await c.env.DB.prepare("SELECT platform, display_name, expires_at FROM accounts WHERE tokens IS NOT NULL")
    .all<{ platform: string; display_name: string; expires_at: string }>()).results;
  const by = Object.fromEntries(rows.map((r) => [r.platform, r]));
  return c.json(PLATFORMS.map((p) => ({
    platform: p,
    available: p === "instagram" && Boolean(c.env.IG_APP_ID && c.env.IG_CONFIG_ID && c.env.IG_APP_SECRET),
    connected: Boolean(by[p]),
    display_name: by[p]?.display_name ?? null,
    expires_at: by[p]?.expires_at ?? null,
  })));
});

app.delete("/api/accounts/:platform", async (c) => {
  await c.env.DB.prepare("DELETE FROM accounts WHERE platform = ?").bind(c.req.param("platform")).run();
  return c.json({ ok: true });
});

const redirectUri = (env: Env, platform: string) => `${env.PUBLIC_URL.replace(/\/$/, "")}/api/oauth/${platform}/callback`;

app.get("/api/oauth/instagram/start", async (c) => {
  if (!c.env.IG_APP_ID || !c.env.IG_CONFIG_ID || !c.env.IG_APP_SECRET) return c.text("Instagram app keys are not set on the server yet.", 400);
  const nonce = crypto.randomUUID();
  const state = `${nonce}.${await sign(c.env.SESSION_KEY, `oauth:instagram:${nonce}`)}`;
  return c.redirect(ig.authorizeUrl(c.env.IG_APP_ID, c.env.IG_CONFIG_ID, redirectUri(c.env, "instagram"), state));
});

app.get("/api/oauth/instagram/callback", async (c) => {
  const back = (msg: string) => c.redirect(`/#settings?msg=${encodeURIComponent(msg)}`);
  const [nonce, sig] = (c.req.query("state") ?? "").split(".");
  if (!nonce || !(await verify(c.env.SESSION_KEY, `oauth:instagram:${nonce}`, sig ?? ""))) return back("Instagram: invalid state, try again");
  const code = c.req.query("code");
  if (!code) return back(`Instagram: ${c.req.query("error_description") ?? "connection cancelled"}`);
  try {
    const r = await ig.connect(fetch, c.env.IG_APP_ID!, c.env.IG_APP_SECRET!, redirectUri(c.env, "instagram"), code.replace(/#_$/, ""));
    await c.env.DB.prepare(
      `INSERT INTO accounts (platform, display_name, tokens, expires_at) VALUES ('instagram', ?, ?, ?)
       ON CONFLICT(platform) DO UPDATE SET display_name = excluded.display_name, tokens = excluded.tokens, expires_at = excluded.expires_at`)
      .bind(`@${r.username}`, await encryptJson(c.env.TOKEN_KEY, r.tokens), r.expires_at).run();
    return back(`Instagram connected as @${r.username}`);
  } catch (e) {
    return back(`Instagram: ${(e as Error).message}`);
  }
});

/** Retry a failed post now (or at its time, if that is still ahead). */
app.post("/api/posts/:id/retry", async (c) => {
  const r = await c.env.DB.prepare(
    "UPDATE posts SET status = 'scheduled', attempts = 0, error = NULL, remote_id = NULL, scheduled_at = MAX(scheduled_at, ?) WHERE id = ? AND status = 'failed'")
    .bind(new Date().toISOString(), c.req.param("id")).run();
  if (!r.meta.changes) return c.json({ error: "not found or not failed" }, 404);
  return c.json({ ok: true });
});

// ---------- media ----------

/** Same as /api/media but for platforms: needs a valid signature instead of a login. */
app.get("/api/public/media/*", async (c) => {
  const key = c.req.path.slice("/api/public/media/".length);
  const exp = c.req.query("exp") ?? "";
  if (!KEY_RE.test(key) || Number(exp) * 1000 < Date.now() ||
      !(await verify(c.env.SESSION_KEY, `media:${key}:${exp}`, c.req.query("sig") ?? ""))) {
    return c.json({ error: "link expired or invalid" }, 403);
  }
  return serveMedia(c, key);
});

app.get("/api/thumb/:id", async (c) => {
  const row = await c.env.DB.prepare("SELECT data, content_type FROM thumbs WHERE clip_id = ?").bind(c.req.param("id"))
    .first<{ data: ArrayBuffer | number[]; content_type: string }>();
  if (!row) return c.json({ error: "no thumbnail" }, 404);
  const bytes = row.data instanceof ArrayBuffer ? new Uint8Array(row.data) : Uint8Array.from(row.data);
  return new Response(bytes, { headers: { "content-type": row.content_type, "cache-control": "private, max-age=86400" } });
});

/** Stream a video or thumbnail from R2, with Range support so the <video> player can seek. */
app.get("/api/media/*", async (c) => {
  const key = c.req.path.slice("/api/media/".length);
  if (!KEY_RE.test(key)) return c.json({ error: "bad key" }, 400);
  return serveMedia(c, key);
});

async function serveMedia(c: Context<App>, key: string) {
  const range = parseRange(c.req.header("range"));
  if (!c.env.MEDIA) return c.json({ error: "videos are kept on the PC" }, 404);
  const obj = await c.env.MEDIA.get(key, range ? { range } : undefined);
  if (!obj) return c.json({ error: "not found" }, 404);
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", "private, max-age=3600");
  if (range && "offset" in range) {
    const start = range.offset ?? 0;
    const end = Math.min(obj.size - 1, start + (range.length ?? obj.size) - 1);
    headers.set("content-range", `bytes ${start}-${end}/${obj.size}`);
    headers.set("content-length", String(end - start + 1));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set("content-length", String(obj.size));
  return new Response(obj.body, { headers });
}

function parseRange(h?: string): { offset: number; length?: number } | undefined {
  const m = h?.match(/^bytes=(\d+)-(\d*)$/);
  if (!m) return undefined;
  const offset = Number(m[1]);
  return m[2] ? { offset, length: Number(m[2]) - offset + 1 } : { offset };
}

// ---------- PC worker API (Bearer token) ----------

app.use("/api/worker/*", async (c, next) => {
  const auth = c.req.header("authorization") ?? "";
  if (!c.env.WORKER_TOKEN || auth !== `Bearer ${c.env.WORKER_TOKEN}`) return c.json({ error: "unauthorized" }, 401);
  await next();
});

app.use("/api/worker/upload/*", async (c, next) => (c.env.MEDIA ? next() : c.json({ error: "no R2 storage: videos are kept on the PC" }, 501)));
app.use("/api/worker/multipart/*", async (c, next) => (c.env.MEDIA ? next() : c.json({ error: "no R2 storage: videos are kept on the PC" }, 501)));

const contentType = (key: string) => (key.endsWith(".mp4") ? "video/mp4" : "image/jpeg");

/** Upload a small file (under 90 MB) straight into R2. */
app.put("/api/worker/upload/*", async (c) => {
  const key = c.req.path.slice("/api/worker/upload/".length);
  if (!KEY_RE.test(key)) return c.json({ error: "bad key" }, 400);
  if (!c.req.raw.body) return c.json({ error: "empty body" }, 400);
  const obj = await c.env.MEDIA!.put(key, c.req.raw.body, { httpMetadata: { contentType: contentType(key) } });
  return c.json({ ok: true, key, size: obj?.size ?? 0 });
});

// Big files go up in parts (Cloudflare limits one request to 100 MB):
// POST ?action=create -> uploadId; PUT ?uploadId&part=N (each part the same size, 5-90 MB, last can be smaller);
// POST ?action=complete&uploadId with {parts:[{partNumber, etag}]}; POST ?action=abort&uploadId
app.post("/api/worker/multipart/*", async (c) => {
  const key = c.req.path.slice("/api/worker/multipart/".length);
  if (!KEY_RE.test(key)) return c.json({ error: "bad key" }, 400);
  const action = c.req.query("action");
  if (action === "create") {
    const mpu = await c.env.MEDIA!.createMultipartUpload(key, { httpMetadata: { contentType: contentType(key) } });
    return c.json({ uploadId: mpu.uploadId });
  }
  const uploadId = c.req.query("uploadId");
  if (!uploadId) return c.json({ error: "uploadId required" }, 400);
  const mpu = c.env.MEDIA!.resumeMultipartUpload(key, uploadId);
  if (action === "complete") {
    const { parts } = await c.req.json<{ parts: R2UploadedPart[] }>();
    const obj = await mpu.complete(parts);
    return c.json({ ok: true, key, size: obj.size });
  }
  if (action === "abort") { await mpu.abort(); return c.json({ ok: true }); }
  return c.json({ error: "unknown action" }, 400);
});

app.put("/api/worker/multipart/*", async (c) => {
  const key = c.req.path.slice("/api/worker/multipart/".length);
  const uploadId = c.req.query("uploadId");
  const part = Number(c.req.query("part"));
  if (!KEY_RE.test(key) || !uploadId || !Number.isInteger(part) || part < 1 || part > 10_000) return c.json({ error: "bad request" }, 400);
  if (!c.req.raw.body) return c.json({ error: "empty body" }, 400);
  const uploaded = await c.env.MEDIA!.resumeMultipartUpload(key, uploadId).uploadPart(part, c.req.raw.body);
  return c.json(uploaded);
});

/** Create (or update, by source + title) a clip record after its files are uploaded. */
app.post("/api/worker/clips", async (c) => {
  const b = await c.req.json<Record<string, unknown>>();
  const str = (k: string) => (typeof b[k] === "string" ? (b[k] as string) : "");
  if (!str("streamer") || !str("title") || !str("id")) return c.json({ error: "id, streamer and title are required" }, 400);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(str("id"))) return c.json({ error: "bad id" }, 400);
  if (!str("video_key") && !str("local_path")) return c.json({ error: "video_key or local_path is required" }, 400);
  // re-imports refresh the files and texts, but never undo your edits to title/captions or your approve/skip
  await c.env.DB.prepare(
    `INSERT INTO clips (id, streamer, title, caption_tiktok, caption_instagram, hook, video_key, thumb_key, duration, score, source_vod, local_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET streamer = excluded.streamer,
       video_key = excluded.video_key, thumb_key = excluded.thumb_key, duration = excluded.duration,
       score = excluded.score, source_vod = excluded.source_vod, local_path = excluded.local_path, hook = excluded.hook`)
    .bind(str("id"), str("streamer"), str("title"), str("caption_tiktok"), str("caption_instagram"), str("hook"),
      str("video_key") || null, str("thumb_key") || null,
      typeof b.duration === "number" ? b.duration : null, typeof b.score === "number" ? b.score : null,
      str("source_vod") || null, str("local_path") || null)
    .run();
  return c.json({ ok: true, id: str("id") });
});

/** Small preview image, stored in the database (no R2 needed). */
app.put("/api/worker/thumb/:id", async (c) => {
  const id = c.req.param("id");
  const data = await c.req.arrayBuffer();
  if (!data.byteLength || data.byteLength > 512 * 1024) return c.json({ error: "thumbnail must be 1 byte to 512 KB" }, 400);
  const clip = await c.env.DB.prepare("SELECT id FROM clips WHERE id = ?").bind(id).first();
  if (!clip) return c.json({ error: "create the clip first" }, 404);
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO thumbs (clip_id, data) VALUES (?, ?) ON CONFLICT(clip_id) DO UPDATE SET data = excluded.data").bind(id, data),
    c.env.DB.prepare("UPDATE clips SET thumb_key = 'db' WHERE id = ?").bind(id),
  ]);
  return c.json({ ok: true });
});

/** Posts whose time has come and whose video is on the PC. The PC poster calls this every minute. */
app.get("/api/worker/due", async (c) => {
  const now = new Date().toISOString();
  await c.env.DB.prepare("INSERT INTO settings (key, value) VALUES ('pc_last_seen', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(JSON.stringify(now)).run();
  const rows = await c.env.DB.prepare(
    `SELECT p.id, p.platform, p.scheduled_at, c.id AS clip_id, c.title, c.local_path, c.caption_instagram, c.caption_tiktok
     FROM posts p JOIN clips c ON c.id = p.clip_id
     WHERE p.status = 'scheduled' AND p.scheduled_at <= ? AND c.local_path IS NOT NULL AND c.video_key IS NULL
     ORDER BY p.scheduled_at LIMIT 5`).bind(now).all();
  return c.json(rows.results);
});

/** PC poster: get an Instagram upload address for a due post. Instagram then processes it and the cron publishes. */
app.post("/api/worker/posts/:id/instagram/start", async (c) => {
  const p = await c.env.DB.prepare(
    `SELECT p.*, c.caption_instagram, c.video_key, c.local_path, NULL AS posting_started_at FROM posts p JOIN clips c ON c.id = p.clip_id
     WHERE p.id = ? AND p.platform = 'instagram'`).bind(c.req.param("id")).first<PostRow>();
  if (!p) return c.json({ error: "not found" }, 404);
  if (p.status !== "scheduled") return c.json({ error: `post is ${p.status}` }, 409);
  const tokens = await loadTokens<ig.IgTokens>(c.env, "instagram");
  if (!tokens) return c.json({ error: "Instagram is not connected" }, 409);
  try {
    const { id, uri } = await ig.createReelResumable(fetch, tokens, p.caption_instagram);
    // claim the post so a second PC poster run cannot start it twice
    const r = await c.env.DB.prepare("UPDATE posts SET status = 'posting', remote_id = ?, posting_started_at = ?, error = NULL WHERE id = ? AND status = 'scheduled'")
      .bind(id, new Date().toISOString(), p.id).run();
    if (!r.meta.changes) return c.json({ error: "already started" }, 409);
    return c.json({ upload_uri: uri, access_token: tokens.access_token });
  } catch (e) {
    const err = e as ig.IgError;
    await retryOrFail(c.env, p, err.message ?? String(e), err instanceof ig.IgError && err.permanent);
    return c.json({ error: err.message }, 502);
  }
});

/** PC poster: the upload itself failed (file missing, network...). */
app.post("/api/worker/posts/:id/fail", async (c) => {
  const { error, permanent } = await c.req.json<{ error?: string; permanent?: boolean }>().catch(() => ({ error: "", permanent: false }));
  const p = await c.env.DB.prepare("SELECT * FROM posts WHERE id = ?").bind(c.req.param("id")).first<PostRow>();
  if (!p) return c.json({ error: "not found" }, 404);
  await retryOrFail(c.env, p, `PC upload: ${error || "unknown error"}`, Boolean(permanent));
  return c.json({ ok: true });
});

app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

export default {
  fetch: app.fetch,
  async scheduled(_ctrl: ScheduledController, env: Env) {
    const stats = await runDue(env);
    if (stats.started || stats.finished || stats.failed) console.log("publisher", JSON.stringify(stats));
    try { await refreshTokens(env); } catch (e) { console.error("token refresh failed", (e as Error).message); }
  },
} satisfies ExportedHandler<Env>;
