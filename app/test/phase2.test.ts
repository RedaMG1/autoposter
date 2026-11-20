import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { decryptJson, encryptJson, sign, verify } from "../src/worker/crypto";
import type { Env } from "../src/worker/env";
import { publicMediaUrl, refreshTokens, runDue } from "../src/worker/publisher";
import { call, WORKER } from "./helpers";

const E = env as unknown as Env;
const raw = (path: string, init?: RequestInit) => SELF.fetch(`https://app.test${path}`, init);

describe("login", () => {
  it("blocks the app API without a session", async () => {
    expect((await raw("/api/clips")).status).toBe(401);
    expect((await raw("/api/settings")).status).toBe(401);
  });
  it("rejects a wrong password", async () => {
    const r = await raw("/api/login", { method: "POST", body: JSON.stringify({ password: "nope" }) });
    expect(r.status).toBe(401);
    expect(r.headers.get("set-cookie")).toBeNull();
  });
  it("rejects a forged cookie", async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const r = await raw("/api/clips", { headers: { cookie: `session=${exp}.forged` } });
    expect(r.status).toBe(401);
  });
  it("lets a logged-in user in and reports it", async () => {
    expect((await call("/api/clips")).status).toBe(200);
    expect(await (await call("/api/me")).json()).toEqual({ loggedIn: true });
  });
  it("keeps health public", async () => {
    expect((await raw("/api/health")).status).toBe(200);
  });
});

describe("crypto", () => {
  it("signs and verifies", async () => {
    const s = await sign("k", "data");
    expect(await verify("k", "data", s)).toBe(true);
    expect(await verify("k", "data2", s)).toBe(false);
    expect(await verify("other", "data", s)).toBe(false);
    expect(await verify("k", "data", "garbage!")).toBe(false);
  });
  it("encrypts tokens so the database never holds them in clear", async () => {
    const box = await encryptJson("key", { access_token: "secret-token" });
    expect(box).not.toContain("secret-token");
    expect(await decryptJson("key", box)).toEqual({ access_token: "secret-token" });
    await expect(decryptJson("wrong", box)).rejects.toThrow();
  });
});

describe("multipart upload", () => {
  it("assembles a file from parts", async () => {
    const key = "clips/big/video.mp4";
    const base = `/api/worker/multipart/${key}`;
    const { uploadId } = await (await call(`${base}?action=create`, { method: "POST", headers: WORKER })).json<{ uploadId: string }>();
    const partSize = 5 * 1024 * 1024; // R2 minimum for all but the last part
    const p1 = new Uint8Array(partSize).fill(1);
    const p2 = new Uint8Array(1000).fill(2);
    const parts = [];
    for (const [i, body] of [p1, p2].entries()) {
      const r = await call(`${base}?uploadId=${encodeURIComponent(uploadId)}&part=${i + 1}`, { method: "PUT", headers: WORKER, body });
      expect(r.status).toBe(200);
      parts.push(await r.json());
    }
    const done = await call(`${base}?action=complete&uploadId=${encodeURIComponent(uploadId)}`, {
      method: "POST", headers: WORKER, body: JSON.stringify({ parts }),
    });
    expect(await done.json()).toMatchObject({ ok: true, size: partSize + 1000 });
    const obj = await env.MEDIA.get(key);
    expect(obj?.httpMetadata?.contentType).toBe("video/mp4");
  });
  it("needs the worker token", async () => {
    expect((await raw("/api/worker/multipart/clips/x/video.mp4?action=create", { method: "POST" })).status).toBe(401);
  });
});

describe("signed public video links", () => {
  it("serves with a valid signature and refuses otherwise", async () => {
    await env.MEDIA.put("clips/pub/video.mp4", "video-bytes", { httpMetadata: { contentType: "video/mp4" } });
    const url = new URL(await publicMediaUrl(E, "clips/pub/video.mp4"));
    expect(url.origin).toBe("https://app.test");
    const ok = await raw(url.pathname + url.search);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("video-bytes");
    const tampered = await raw(url.pathname.replace("/pub/", "/abc/") + url.search);
    expect(tampered.status).toBe(403);
    const expired = new URL(await publicMediaUrl(E, "clips/pub/video.mp4", -1000));
    expect((await raw(expired.pathname + expired.search)).status).toBe(403);
  });
});

// ---------- Instagram publisher against a fake Instagram ----------

type Handler = (url: URL, init?: RequestInit) => unknown;
function fakeFetch(routes: Record<string, Handler>) {
  const calls: string[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
    for (const [pattern, h] of Object.entries(routes)) {
      if (url.pathname.endsWith(pattern)) {
        const body = h(url, init);
        if (body instanceof Response) return body;
        return new Response(JSON.stringify(body), { status: 200 });
      }
    }
    return new Response(JSON.stringify({ error: { message: `no fake for ${url.pathname}` } }), { status: 404 });
  }) as typeof fetch;
  return { f, calls };
}

async function connectInstagram() {
  await env.DB.prepare("INSERT OR REPLACE INTO accounts (platform, display_name, tokens, expires_at) VALUES ('instagram', '@me', ?, ?)")
    .bind(await encryptJson(E.TOKEN_KEY, { access_token: "tok", user_id: "42" }), new Date(Date.now() + 50 * 86_400_000).toISOString()).run();
}

async function duePost(id: string, platform = "instagram") {
  await env.DB.prepare("INSERT OR IGNORE INTO clips (id, streamer, title, caption_instagram, video_key, status) VALUES (?, 'S', 'T', 'cap', ?, 'approved')")
    .bind(id, `clips/${id}/video.mp4`).run();
  await env.DB.prepare("INSERT INTO posts (id, clip_id, platform, scheduled_at) VALUES (?, ?, ?, ?)")
    .bind(`${id}-${platform}`, id, platform, new Date(Date.now() - 60_000).toISOString()).run();
}

const post = (id: string) => env.DB.prepare("SELECT * FROM posts WHERE id = ?").bind(id).first<Record<string, unknown>>();

describe("Instagram publishing", () => {
  it("creates a container, waits for processing, then publishes", async () => {
    await connectInstagram();
    await duePost("ig1");
    let status = "IN_PROGRESS";
    let sentVideoUrl = "";
    const { f, calls } = fakeFetch({
      "/42/media": (_u, init) => { sentVideoUrl = new URLSearchParams(String(init?.body)).get("video_url")!; return { id: "container1" }; },
      "/container1": () => ({ status_code: status }),
      "/42/media_publish": () => ({ id: "media9" }),
      "/media9": () => ({ permalink: "https://instagram.com/reel/abc" }),
    });

    await runDue(E, f);
    expect(await post("ig1-instagram")).toMatchObject({ status: "posting", remote_id: "container1" });
    expect(sentVideoUrl).toMatch(/^https:\/\/app\.test\/api\/public\/media\/clips\/ig1\/video\.mp4\?exp=\d+&sig=/);

    await runDue(E, f); // still processing: nothing changes
    expect((await post("ig1-instagram"))?.status).toBe("posting");

    status = "FINISHED";
    await runDue(E, f);
    expect(await post("ig1-instagram")).toMatchObject({ status: "posted", remote_id: "media9", remote_url: "https://instagram.com/reel/abc" });
    expect(calls.filter((c) => c.startsWith("POST")).length).toBe(2); // one create, one publish
  });

  it("fails with a clear message when Instagram is not connected", async () => {
    await env.DB.prepare("DELETE FROM accounts").run();
    await duePost("ig2");
    await runDue(E, fakeFetch({}).f);
    const p = await post("ig2-instagram");
    expect(p?.status).toBe("failed");
    expect(p?.error).toContain("not connected");
  });

  it("does not retry a request Instagram rejects", async () => {
    await connectInstagram();
    await duePost("ig3");
    const { f } = fakeFetch({
      "/42/media": () => new Response(JSON.stringify({ error: { message: "Invalid video format" } }), { status: 400 }),
    });
    await runDue(E, f);
    const p = await post("ig3-instagram");
    expect(p?.status).toBe("failed");
    expect(p?.error).toContain("Invalid video format");
  });

  it("retries server errors, then gives up after 3 tries", async () => {
    await connectInstagram();
    await duePost("ig4");
    const { f } = fakeFetch({ "/42/media": () => new Response("{}", { status: 500 }) });
    await runDue(E, f);
    expect(await post("ig4-instagram")).toMatchObject({ status: "scheduled", attempts: 1 });
    await runDue(E, f);
    await runDue(E, f);
    expect(await post("ig4-instagram")).toMatchObject({ status: "failed" });
  });

  it("marks TikTok and YouTube as not set up yet", async () => {
    await duePost("tt1", "tiktok");
    await runDue(E, fakeFetch({}).f);
    expect((await post("tt1-tiktok"))?.error).toContain("not set up yet");
  });

  it("does not touch posts that are not due", async () => {
    await env.DB.prepare("INSERT INTO clips (id, streamer, title, status) VALUES ('later', 'S', 'T', 'approved')").run();
    await env.DB.prepare("INSERT INTO posts (id, clip_id, platform, scheduled_at) VALUES ('later-ig', 'later', 'instagram', ?)")
      .bind(new Date(Date.now() + 3600_000).toISOString()).run();
    const { f, calls } = fakeFetch({});
    await runDue(E, f);
    expect(calls).toHaveLength(0);
    expect((await post("later-ig"))?.status).toBe("scheduled");
  });

  it("refreshes the token when fewer than 10 days are left", async () => {
    await env.DB.prepare("INSERT OR REPLACE INTO accounts (platform, display_name, tokens, expires_at) VALUES ('instagram', '@me', ?, ?)")
      .bind(await encryptJson(E.TOKEN_KEY, { access_token: "old", user_id: "42" }), new Date(Date.now() + 5 * 86_400_000).toISOString()).run();
    const { f } = fakeFetch({ "/refresh_access_token": () => ({ access_token: "new", expires_in: 5_184_000 }) });
    expect(await refreshTokens(E, f)).toBe(true);
    const row = await env.DB.prepare("SELECT tokens FROM accounts WHERE platform = 'instagram'").first<{ tokens: string }>();
    expect(await decryptJson(E.TOKEN_KEY, row!.tokens)).toEqual({ access_token: "new", user_id: "42" });
  });

  it("lets a failed post be retried from the app", async () => {
    await env.DB.prepare("DELETE FROM accounts").run();
    await duePost("ig5");
    await runDue(E, fakeFetch({}).f);
    const r = await call("/api/posts/ig5-instagram/retry", { method: "POST" });
    expect(r.status).toBe(200);
    expect(await post("ig5-instagram")).toMatchObject({ status: "scheduled", attempts: 0, error: null });
  });
});

describe("Instagram unified login", () => {
  it("turns the login code into a never-expiring token for the picked Instagram account", async () => {
    const { connect, authorizeUrl } = await import("../src/worker/instagram");
    const { f, calls } = fakeFetch({
      "/oauth/access_token": (u) => { expect(u.searchParams.get("code")).toBe("CODE"); return { access_token: "SUAT" }; },
      "/debug_token": () => ({ data: { granular_scopes: [{ scope: "instagram_basic", target_ids: ["999"] }, { scope: "instagram_content_publish", target_ids: ["999"] }] } }),
      "/999": () => ({ id: "999", username: "five.stars6" }),
    });
    const r = await connect(f, "APP", "SECRET", "https://app.test/cb", "CODE");
    expect(r).toEqual({ tokens: { access_token: "SUAT", user_id: "999" }, username: "five.stars6", expires_at: null });
    expect(calls).toEqual(["GET /v25.0/oauth/access_token", "GET /v25.0/debug_token", "GET /v25.0/999"]);
    const url = new URL(authorizeUrl("APP", "CFG", "https://app.test/cb", "st"));
    expect(url.searchParams.get("config_id")).toBe("CFG");
    expect(url.hostname).toBe("www.facebook.com");
  });

  it("explains when no Instagram account was picked", async () => {
    const { connect } = await import("../src/worker/instagram");
    const { f } = fakeFetch({
      "/oauth/access_token": () => ({ access_token: "SUAT" }),
      "/debug_token": () => ({ data: { granular_scopes: [] } }),
    });
    await expect(connect(f, "APP", "SECRET", "https://app.test/cb", "CODE")).rejects.toThrow(/Creator or Business/);
  });
});

describe("accounts", () => {
  it("shows Instagram as unavailable until the app keys are set", async () => {
    const list = await (await call("/api/accounts")).json<{ platform: string; available: boolean }[]>();
    expect(list.find((a) => a.platform === "instagram")?.available).toBe(false);
  });
});
