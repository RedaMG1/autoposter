import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encryptJson } from "../src/worker/crypto";
import type { Env } from "../src/worker/env";
import { runDue } from "../src/worker/publisher";
import { call, WORKER } from "./helpers";

const E = env as unknown as Env;
const post = (id: string) => env.DB.prepare("SELECT * FROM posts WHERE id = ?").bind(id).first<Record<string, unknown>>();

async function pcClip(id: string, dueInMs = -60_000) {
  await env.DB.prepare("INSERT INTO clips (id, streamer, title, caption_instagram, local_path, status) VALUES (?, 'S', 'T', 'cap', ?, 'approved')")
    .bind(id, `C:/clips/${id}.mp4`).run();
  await env.DB.prepare("INSERT INTO posts (id, clip_id, platform, scheduled_at) VALUES (?, ?, 'instagram', ?)")
    .bind(`${id}-ig`, id, new Date(Date.now() + dueInMs).toISOString()).run();
}

async function connectInstagram() {
  await env.DB.prepare("INSERT OR REPLACE INTO accounts (platform, display_name, tokens, expires_at) VALUES ('instagram', '@me', ?, ?)")
    .bind(await encryptJson(E.TOKEN_KEY, { access_token: "tok", user_id: "42" }), new Date(Date.now() + 50 * 86_400_000).toISOString()).run();
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("thumbnails in the database", () => {
  it("stores and serves a thumbnail", async () => {
    await call("/api/worker/clips", { method: "POST", headers: WORKER, body: JSON.stringify({ id: "t1", streamer: "S", title: "T", local_path: "C:/t1.mp4" }) });
    const img = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]);
    expect((await call("/api/worker/thumb/t1", { method: "PUT", headers: WORKER, body: img })).status).toBe(200);
    const r = await call("/api/thumb/t1");
    expect(r.headers.get("content-type")).toBe("image/jpeg");
    expect([...new Uint8Array(await r.arrayBuffer())]).toEqual([...img]);
    const clip = await (await call("/api/clips/t1")).json<{ thumb_key: string }>();
    expect(clip.thumb_key).toBe("db");
  });
  it("refuses huge thumbnails and unknown clips", async () => {
    expect((await call("/api/worker/thumb/nope", { method: "PUT", headers: WORKER, body: new Uint8Array(10) })).status).toBe(404);
    expect((await call("/api/worker/thumb/t1", { method: "PUT", headers: WORKER, body: new Uint8Array(600 * 1024) })).status).toBe(400);
  });
});

describe("PC poster flow", () => {
  it("lists only due posts whose video is on the PC, and records that the PC checked in", async () => {
    await pcClip("d1");
    await pcClip("d2", 3600_000); // not due yet
    const due = await (await call("/api/worker/due", { headers: WORKER })).json<{ id: string; local_path: string }[]>();
    expect(due.map((d) => d.id)).toEqual(["d1-ig"]);
    expect(due[0].local_path).toBe("C:/clips/d1.mp4");
    const s = await (await call("/api/settings")).json<{ pc_last_seen: string }>();
    expect(Date.now() - Date.parse(s.pc_last_seen)).toBeLessThan(10_000);
  });

  it("the cron leaves PC posts alone instead of failing them", async () => {
    await connectInstagram();
    await pcClip("d3");
    await runDue(E, (async () => new Response("{}")) as typeof fetch);
    expect((await post("d3-ig"))?.status).toBe("scheduled");
  });

  it("start creates a resumable Instagram upload and claims the post once", async () => {
    await connectInstagram();
    await pcClip("d4");
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body ?? ""));
      seen.push(`${new URL(String(input)).pathname} ${body.get("upload_type")}`);
      return new Response(JSON.stringify({ id: "cont1", uri: "https://rupload.facebook.com/ig-api-upload/v23.0/cont1" }));
    });
    const r = await call("/api/worker/posts/d4-ig/instagram/start", { method: "POST", headers: WORKER });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ upload_uri: "https://rupload.facebook.com/ig-api-upload/v23.0/cont1", access_token: "tok" });
    expect(seen).toEqual(["/v23.0/42/media resumable"]);
    expect(await post("d4-ig")).toMatchObject({ status: "posting", remote_id: "cont1" });
    const again = await call("/api/worker/posts/d4-ig/instagram/start", { method: "POST", headers: WORKER });
    expect(again.status).toBe(409);
  });

  it("a PC upload failure is retried, then reported", async () => {
    await pcClip("d5");
    const fail = () => call("/api/worker/posts/d5-ig/fail", { method: "POST", headers: WORKER, body: JSON.stringify({ error: "file not found" }) });
    await fail();
    expect(await post("d5-ig")).toMatchObject({ status: "scheduled", attempts: 1 });
    await fail();
    await fail();
    const p = await post("d5-ig");
    expect(p?.status).toBe("failed");
    expect(p?.error).toContain("file not found");
  });

  it("a missing file is not retried", async () => {
    await pcClip("d6");
    await call("/api/worker/posts/d6-ig/fail", { method: "POST", headers: WORKER, body: JSON.stringify({ error: "file not found", permanent: true }) });
    expect((await post("d6-ig"))?.status).toBe("failed");
  });

  it("needs the worker token", async () => {
    const { SELF } = await import("cloudflare:test");
    expect((await SELF.fetch("https://app.test/api/worker/due")).status).toBe(401);
  });
});
