import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { call, WORKER as W } from "./helpers";

const json = (body: unknown) => ({ method: "POST", headers: W, body: JSON.stringify(body) });

async function addClip(id: string, streamer = "Jynxzi", extra: Record<string, unknown> = {}) {
  const r = await call("/api/worker/clips", json({ id, streamer, title: `${streamer} clip ${id}`, score: 8, local_path: `C:/clips/${id}.mp4`, ...extra }));
  expect(r.status).toBe(200);
}

describe("health", () => {
  it("answers", async () => {
    expect(await (await call("/api/health")).json()).toEqual({ ok: true });
  });
});

describe("worker API", () => {
  it("rejects requests without the token", async () => {
    const r = await call("/api/worker/clips", { method: "POST", body: "{}" });
    expect(r.status).toBe(401);
  });

  it("rejects bad upload keys", async () => {
    for (const key of ["clips/abc/evil.exe", "other/abc/video.mp4", "clips/a%2F..%2Fb/video.mp4"]) {
      const r = await call(`/api/worker/upload/${key}`, { method: "PUT", headers: W, body: "x" });
      expect(r.status, key).toBe(400);
    }
  });

  it("stores an upload and serves it back with range support", async () => {
    const data = new Uint8Array(1000).map((_, i) => i % 256);
    const up = await call("/api/worker/upload/clips/abc/video.mp4", { method: "PUT", headers: W, body: data });
    expect(up.status).toBe(200);
    const full = await call("/api/media/clips/abc/video.mp4");
    expect(full.headers.get("content-type")).toBe("video/mp4");
    expect((await full.arrayBuffer()).byteLength).toBe(1000);
    const part = await call("/api/media/clips/abc/video.mp4", { headers: { range: "bytes=10-19" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 10-19/1000");
    expect([...new Uint8Array(await part.arrayBuffer())]).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  });

  it("re-importing updates files but keeps your edits and decisions", async () => {
    await addClip("c1");
    await call("/api/clips/c1", { method: "PATCH", headers: W, body: JSON.stringify({ title: "my edited title" }) });
    await call("/api/clips/c1/skip", { method: "POST" });
    await addClip("c1", "Jynxzi", { title: "importer title", local_path: "D:/moved/c1.mp4", score: 9 });
    const clips = await (await call("/api/clips")).json<{ id: string; title: string; status: string; local_path: string; score: number }[]>();
    expect(clips).toHaveLength(1);
    expect(clips[0]).toMatchObject({ id: "c1", title: "my edited title", status: "skipped", local_path: "D:/moved/c1.mp4", score: 9 });
  });

  it("needs a video location", async () => {
    const r = await call("/api/worker/clips", json({ id: "nov", streamer: "S", title: "T" }));
    expect(r.status).toBe(400);
  });
});

describe("approve and schedule", () => {
  it("approving creates one post per platform at the same slot", async () => {
    await addClip("a1");
    const r = await (await call("/api/clips/a1/approve", { method: "POST" })).json<{ scheduled_at: string }>();
    expect(Date.parse(r.scheduled_at)).toBeGreaterThan(Date.now());
    const clip = await (await call("/api/clips/a1")).json<{ status: string; posts: { platform: string; scheduled_at: string }[] }>();
    expect(clip.status).toBe("approved");
    expect(clip.posts.map((p) => p.platform)).toEqual(["instagram", "tiktok", "youtube"]);
    expect(new Set(clip.posts.map((p) => p.scheduled_at)).size).toBe(1);
  });

  it("approving twice does not double-book", async () => {
    await addClip("a2");
    const first = await (await call("/api/clips/a2/approve", { method: "POST" })).json<{ scheduled_at: string }>();
    const second = await (await call("/api/clips/a2/approve", { method: "POST" })).json<{ scheduled_at: string }>();
    expect(second.scheduled_at).toBe(first.scheduled_at);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM posts WHERE clip_id = 'a2'").first<{ n: number }>();
    expect(n?.n).toBe(3);
  });

  it("two clips get different slots", async () => {
    await addClip("b1", "Lirik");
    await addClip("b2", "squeex");
    const s1 = await (await call("/api/clips/b1/approve", { method: "POST" })).json<{ scheduled_at: string }>();
    const s2 = await (await call("/api/clips/b2/approve", { method: "POST" })).json<{ scheduled_at: string }>();
    expect(s1.scheduled_at).not.toBe(s2.scheduled_at);
  });

  it("skipping removes scheduled posts", async () => {
    await addClip("s1");
    await call("/api/clips/s1/approve", { method: "POST" });
    await call("/api/clips/s1/skip", { method: "POST" });
    const clip = await (await call("/api/clips/s1")).json<{ status: string; posts: unknown[] }>();
    expect(clip.status).toBe("skipped");
    expect(clip.posts).toHaveLength(0);
  });

  it("only uses the platforms enabled in settings", async () => {
    await call("/api/settings", { method: "PUT", headers: W, body: JSON.stringify({ platforms: ["instagram"] }) });
    await addClip("p1");
    await call("/api/clips/p1/approve", { method: "POST" });
    const clip = await (await call("/api/clips/p1")).json<{ posts: { platform: string }[] }>();
    expect(clip.posts.map((p) => p.platform)).toEqual(["instagram"]);
  });

  it("can move a clip to another time but not into the past", async () => {
    await addClip("m1");
    await call("/api/clips/m1/approve", { method: "POST" });
    const later = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const ok = await call("/api/clips/m1/schedule", { method: "PATCH", headers: W, body: JSON.stringify({ scheduled_at: later }) });
    expect(ok.status).toBe(200);
    const past = await call("/api/clips/m1/schedule", { method: "PATCH", headers: W, body: JSON.stringify({ scheduled_at: "2020-01-01T00:00:00Z" }) });
    expect(past.status).toBe(400);
    const clip = await (await call("/api/clips/m1")).json<{ posts: { scheduled_at: string }[] }>();
    expect(clip.posts.every((p) => p.scheduled_at === later)).toBe(true);
  });
});

describe("post now", () => {
  it("approves and makes every enabled platform due right away", async () => {
    await call("/api/settings", { method: "PUT", headers: W, body: JSON.stringify({ platforms: ["instagram", "tiktok", "youtube"] }) });
    await addClip("n1");
    const r = await (await call("/api/clips/n1/post-now", { method: "POST" })).json<{ platforms: string[] }>();
    expect(r.platforms).toEqual(["instagram", "tiktok", "youtube"]);
    const clip = await (await call("/api/clips/n1")).json<{ status: string; posts: { scheduled_at: string; status: string }[] }>();
    expect(clip.status).toBe("approved");
    expect(clip.posts).toHaveLength(3);
    for (const p of clip.posts) expect(Date.now() - Date.parse(p.scheduled_at)).toBeLessThan(10_000);
  });

  it("moves an already scheduled clip to now and leaves posted platforms alone", async () => {
    await call("/api/settings", { method: "PUT", headers: W, body: JSON.stringify({ platforms: ["instagram", "tiktok"] }) });
    await addClip("n2");
    await call("/api/clips/n2/approve", { method: "POST" });
    await env.DB.prepare("UPDATE posts SET status = 'posted' WHERE clip_id = 'n2' AND platform = 'instagram'").run();
    const r = await (await call("/api/clips/n2/post-now", { method: "POST" })).json<{ platforms: string[] }>();
    expect(r.platforms).toEqual(["tiktok"]);
    const posts = (await env.DB.prepare("SELECT platform, status, scheduled_at FROM posts WHERE clip_id = 'n2' ORDER BY platform").all<{ platform: string; status: string; scheduled_at: string }>()).results;
    expect(posts.find((p) => p.platform === "instagram")?.status).toBe("posted");
    expect(Date.now() - Date.parse(posts.find((p) => p.platform === "tiktok")!.scheduled_at)).toBeLessThan(10_000);
  });
});

describe("editing", () => {
  it("updates captions and ignores unknown fields", async () => {
    await addClip("e1");
    const r = await call("/api/clips/e1", { method: "PATCH", headers: W, body: JSON.stringify({ caption_tiktok: " new ", status: "approved" }) });
    expect(r.status).toBe(200);
    const clip = await (await call("/api/clips/e1")).json<{ caption_tiktok: string; status: string }>();
    expect(clip).toMatchObject({ caption_tiktok: "new", status: "waiting" });
  });

  it("rejects invalid settings", async () => {
    const r = await call("/api/settings", { method: "PUT", headers: W, body: JSON.stringify({ slots: ["noon"] }) });
    expect(r.status).toBe(400);
  });
});
