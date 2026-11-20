import { Hono } from "hono";
import { pickSlot, type Taken } from "./slots";

export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  ASSETS: Fetcher;
  TIMEZONE: string;
  WORKER_TOKEN: string; // secret shared with the PC worker
}

type App = { Bindings: Env };
const app = new Hono<App>();

const PLATFORMS = ["instagram", "tiktok", "youtube"] as const;
const KEY_RE = /^clips\/[A-Za-z0-9_-]{1,64}\/(video\.mp4|thumb\.jpg)$/;
const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 16);

async function getSetting<T>(db: D1Database, key: string, fallback: T): Promise<T> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return row ? (JSON.parse(row.value) as T) : fallback;
}

// ---------- public API (behind Cloudflare Access in production) ----------

app.get("/api/health", (c) => c.json({ ok: true }));

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

/** Stream a video or thumbnail from R2, with Range support so the <video> player can seek. */
app.get("/api/media/*", async (c) => {
  const key = c.req.path.slice("/api/media/".length);
  if (!KEY_RE.test(key)) return c.json({ error: "bad key" }, 400);
  const range = parseRange(c.req.header("range"));
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
});

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

/** Upload a clip file (video or thumbnail) straight into R2. */
app.put("/api/worker/upload/*", async (c) => {
  const key = c.req.path.slice("/api/worker/upload/".length);
  if (!KEY_RE.test(key)) return c.json({ error: "bad key" }, 400);
  if (!c.req.raw.body) return c.json({ error: "empty body" }, 400);
  const type = key.endsWith(".mp4") ? "video/mp4" : "image/jpeg";
  const obj = await c.env.MEDIA.put(key, c.req.raw.body, { httpMetadata: { contentType: type } });
  return c.json({ ok: true, key, size: obj?.size ?? 0 });
});

/** Create (or update, by source + title) a clip record after its files are uploaded. */
app.post("/api/worker/clips", async (c) => {
  const b = await c.req.json<Record<string, unknown>>();
  const str = (k: string) => (typeof b[k] === "string" ? (b[k] as string) : "");
  if (!str("streamer") || !str("title") || !str("id")) return c.json({ error: "id, streamer and title are required" }, 400);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(str("id"))) return c.json({ error: "bad id" }, 400);
  await c.env.DB.prepare(
    `INSERT INTO clips (id, streamer, title, caption_tiktok, caption_instagram, hook, video_key, thumb_key, duration, score, source_vod)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET streamer = excluded.streamer, title = excluded.title,
       caption_tiktok = excluded.caption_tiktok, caption_instagram = excluded.caption_instagram, hook = excluded.hook,
       video_key = excluded.video_key, thumb_key = excluded.thumb_key, duration = excluded.duration,
       score = excluded.score, source_vod = excluded.source_vod`)
    .bind(str("id"), str("streamer"), str("title"), str("caption_tiktok"), str("caption_instagram"), str("hook"),
      str("video_key") || null, str("thumb_key") || null,
      typeof b.duration === "number" ? b.duration : null, typeof b.score === "number" ? b.score : null,
      str("source_vod") || null)
    .run();
  return c.json({ ok: true, id: str("id") });
});

app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

export default {
  fetch: app.fetch,
  // Phase 2 adds the publishers; for now the cron only counts what is due.
  async scheduled(_ctrl: ScheduledController, env: Env) {
    const due = await env.DB.prepare("SELECT COUNT(*) AS n FROM posts WHERE status = 'scheduled' AND scheduled_at <= ?")
      .bind(new Date().toISOString()).first<{ n: number }>();
    console.log(`due posts: ${due?.n ?? 0} (publishers arrive in phase 2)`);
  },
} satisfies ExportedHandler<Env>;
