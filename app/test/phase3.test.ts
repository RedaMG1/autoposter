import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanCaption, finalCaption, hashtags, youtubeText } from "../src/worker/captions";
import { encryptJson } from "../src/worker/crypto";
import type { Env } from "../src/worker/env";
import { runDue } from "../src/worker/publisher";
import * as tt from "../src/worker/tiktok";
import * as yt from "../src/worker/youtube";
import { call, WORKER } from "./helpers";

const E = env as unknown as Env;
const post = (id: string) => env.DB.prepare("SELECT * FROM posts WHERE id = ?").bind(id).first<Record<string, unknown>>();
afterEach(() => { vi.unstubAllGlobals(); });

const clip = {
  title: "Jynxzi tries to land a plane in the water in GTA 6", streamer: "Jynxzi",
  caption_instagram: "Smooth landing? 💀 Stream: Jynxzi #GTA6 #Jynxzi", caption_tiktok: "Landing went great 💀 #GTA6",
  source_vod: "https://www.twitch.tv/videos/1",
};

describe("captions and hashtags", () => {
  it("strips old hashtags and credit lines", () => {
    expect(cleanCaption("Nice one 💀 Stream: Jynxzi #GTA6 #Jynxzi #gaming")).toBe("Nice one 💀");
  });
  it("Instagram gets 6-9 focused tags, no duplicates, plus a credit line", () => {
    const tags = hashtags("instagram", clip);
    expect(tags.length).toBeGreaterThanOrEqual(6);
    expect(tags.length).toBeLessThanOrEqual(9);
    expect(new Set(tags.map((t) => t.toLowerCase())).size).toBe(tags.length);
    expect(tags).toContain("#GTA6");
    expect(tags).toContain("#Jynxzi");
    const text = finalCaption("instagram", clip);
    expect(text.startsWith("Smooth landing? 💀")).toBe(true);
    expect(text).toContain("🎥 Jynxzi on Twitch");
    expect(text.match(/#GTA6\b/g)).toHaveLength(1);
  });
  it("TikTok gets 3-5 tags including #fyp", () => {
    const tags = hashtags("tiktok", clip);
    expect(tags.length).toBeGreaterThanOrEqual(3);
    expect(tags.length).toBeLessThanOrEqual(5);
    expect(tags).toContain("#fyp");
    expect(finalCaption("tiktok", clip)).toContain("Landing went great");
  });
  it("YouTube title gets #Shorts and stays under 100 characters", () => {
    const y = youtubeText(clip);
    expect(y.title).toBe("Jynxzi tries to land a plane in the water in GTA 6 #Shorts");
    expect(y.description).toContain("Full stream: https://www.twitch.tv/videos/1");
    expect(y.description).toContain("#Shorts");
    const long = youtubeText({ ...clip, title: "x".repeat(99) });
    expect(long.title.length).toBeLessThanOrEqual(100);
  });
  it("streamer names with symbols make valid tags", () => {
    expect(hashtags("tiktok", { ...clip, streamer: "penguinz0 (Charlie)" })).toContain("#penguinz0Charlie");
  });
});

describe("TikTok chunking", () => {
  it("one chunk up to 64 MB, else equal 10 MB chunks with the rest in the last", () => {
    const MB = 1024 * 1024;
    expect(tt.chunking(40 * MB)).toEqual({ chunk_size: 40 * MB, total_chunk_count: 1 });
    expect(tt.chunking(156 * MB)).toEqual({ chunk_size: 10 * MB, total_chunk_count: 15 });
  });
});

async function connect(platform: "youtube" | "tiktok") {
  const tokens = platform === "youtube"
    ? { access_token: "yt-tok", refresh_token: "yt-ref", expires_at: Date.now() + 3600_000, channel_id: "UC1" }
    : { access_token: "tt-tok", refresh_token: "tt-ref", expires_at: Date.now() + 3600_000, open_id: "o1" };
  await env.DB.prepare("INSERT OR REPLACE INTO accounts (platform, display_name, tokens) VALUES (?, ?, ?)")
    .bind(platform, platform === "tiktok" ? "@five.stars6" : "Five stars", await encryptJson(E.TOKEN_KEY, tokens)).run();
}

async function duePc(id: string, platform: string) {
  await env.DB.prepare("INSERT OR IGNORE INTO clips (id, streamer, title, caption_instagram, caption_tiktok, local_path, status) VALUES (?, 'Jynxzi', 'Jynxzi lands in GTA 6', 'cap ig', 'cap tt', ?, 'approved')")
    .bind(id, `C:/clips/${id}.mp4`).run();
  await env.DB.prepare("INSERT INTO posts (id, clip_id, platform, scheduled_at) VALUES (?, ?, ?, ?)")
    .bind(`${id}-${platform}`, id, platform, new Date(Date.now() - 60_000).toISOString()).run();
}

describe("YouTube from the PC", () => {
  it("start gives a resumable upload address with Shorts metadata, uploaded marks it posted", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://www.googleapis.com/upload/youtube/v3/videos")) {
        const meta = JSON.parse(String(init?.body));
        expect(meta.snippet.title).toContain("#Shorts");
        expect(meta.status.privacyStatus).toBe("public");
        expect(new Headers(init?.headers).get("x-upload-content-length")).toBe("1234");
        return new Response("", { status: 200, headers: { location: "https://upload.example/session1" } });
      }
      return new Response("{}", { status: 404 });
    });
    await connect("youtube");
    await duePc("y1", "youtube");
    // YouTube is not "ready" without client keys, but start only needs the stored tokens
    const r = await call("/api/worker/posts/y1-youtube/start", { method: "POST", headers: WORKER, body: JSON.stringify({ file_size: 1234 }) });
    expect(await r.json()).toEqual({ kind: "youtube", upload_uri: "https://upload.example/session1", access_token: "yt-tok" });
    expect((await post("y1-youtube"))?.status).toBe("posting");
    const done = await call("/api/worker/posts/y1-youtube/uploaded", { method: "POST", headers: WORKER, body: JSON.stringify({ remote_id: "abcDEF12345" }) });
    expect(done.status).toBe(200);
    expect(await post("y1-youtube")).toMatchObject({ status: "posted", remote_url: "https://youtube.com/shorts/abcDEF12345" });
  });

  it("needs the file size", async () => {
    await connect("youtube");
    await duePc("y2", "youtube");
    const r = await call("/api/worker/posts/y2-youtube/start", { method: "POST", headers: WORKER, body: "{}" });
    expect(r.status).toBe(400);
  });

  it("refreshes an expired Google token", async () => {
    const calls: string[] = [];
    const f = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ access_token: "new", expires_in: 3600 }));
    }) as typeof fetch;
    const r = await yt.fresh(f, "id", "secret", { access_token: "old", refresh_token: "r", expires_at: Date.now() - 1, channel_id: "c" });
    expect(r.changed).toBe(true);
    expect(r.tokens.access_token).toBe("new");
    expect(calls).toEqual(["https://oauth2.googleapis.com/token"]);
  });
});

describe("TikTok from the PC", () => {
  it("posts with the creator's own choices, then the cron sees it published", async () => {
    let initBody: { post_info: Record<string, unknown>; source_info: { video_size: number } } | null = null;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/creator_info/query/")) return Response.json({ data: { privacy_level_options: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"], duet_disabled: true }, error: { code: "ok" } });
      if (url.endsWith("/post/publish/video/init/")) {
        initBody = JSON.parse(String(init?.body));
        return Response.json({ data: { publish_id: "pub1", upload_url: "https://upload.tiktok/x" }, error: { code: "ok" } });
      }
      return new Response("{}", { status: 404 });
    });
    await connect("tiktok");
    await duePc("t1", "tiktok");
    const save = await call("/api/clips/t1", { method: "PATCH", body: JSON.stringify({ tt_settings: { privacy: "PUBLIC_TO_EVERYONE", comment: true, duet: true, stitch: false, brand_organic: true, brand_content: false } }) });
    expect(save.status).toBe(200);
    const r = await call("/api/worker/posts/t1-tiktok/start", { method: "POST", headers: WORKER, body: JSON.stringify({ file_size: 5000 }) });
    expect(await r.json()).toEqual({ kind: "tiktok", upload_url: "https://upload.tiktok/x", chunk_size: 5000, total_chunk_count: 1, privacy: "PUBLIC_TO_EVERYONE" });
    expect(initBody!.post_info).toMatchObject({
      privacy_level: "PUBLIC_TO_EVERYONE", disable_comment: false,
      disable_duet: true, // turned off in the creator's TikTok settings wins
      disable_stitch: true, brand_organic_toggle: true, brand_content_toggle: false,
    });
    expect(String(initBody!.post_info.title)).toContain("#fyp");
    expect(await post("t1-tiktok")).toMatchObject({ status: "posting", remote_id: "pub1" });

    const f = (async (input: RequestInfo | URL) => String(input).endsWith("/status/fetch/")
      ? Response.json({ data: { status: "PUBLISH_COMPLETE", publicaly_available_post_id: [7311] }, error: { code: "ok" } })
      : new Response("{}", { status: 404 })) as typeof fetch;
    await runDue(E, f);
    expect(await post("t1-tiktok")).toMatchObject({ status: "posted", remote_url: "https://www.tiktok.com/@five.stars6/video/7311" });
  });

  it("without any TikTok choices the video goes to the inbox as a draft", async () => {
    const hits: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input); hits.push(url);
      if (url.endsWith("/inbox/video/init/")) return Response.json({ data: { publish_id: "d1", upload_url: "https://upload.tiktok/d" }, error: { code: "ok" } });
      return new Response("{}", { status: 404 });
    });
    await connect("tiktok");
    await duePc("t5", "tiktok");
    const r = await call("/api/worker/posts/t5-tiktok/start", { method: "POST", headers: WORKER, body: JSON.stringify({ file_size: 5000 }) });
    expect(await r.json()).toMatchObject({ privacy: "INBOX", upload_url: "https://upload.tiktok/d" });
    expect(hits.some((h) => h.endsWith("/post/publish/video/init/"))).toBe(false);
  });

  it("the default choices from Settings are used, and a choice TikTok no longer offers fails clearly", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => String(input).endsWith("/creator_info/query/")
      ? Response.json({ data: { privacy_level_options: ["SELF_ONLY"] }, error: { code: "ok" } })
      : new Response("{}", { status: 404 }));
    await connect("tiktok");
    await duePc("t6", "tiktok");
    const put = await call("/api/settings", { method: "PUT", body: JSON.stringify({ tiktok: { privacy: "PUBLIC_TO_EVERYONE" } }) });
    expect(put.status).toBe(200);
    const r = await call("/api/worker/posts/t6-tiktok/start", { method: "POST", headers: WORKER, body: JSON.stringify({ file_size: 5000 }) });
    expect(r.status).toBe(502);
    const p = await post("t6-tiktok");
    expect(p?.status).toBe("failed");
    expect(String(p?.error)).toContain("choose who can see it again");
    await call("/api/settings", { method: "PUT", body: JSON.stringify({ tiktok: null }) });
  });

  it("refuses choices without a privacy pick, or branded content set to private", async () => {
    await duePc("t7", "tiktok");
    const noPick = await call("/api/clips/t7", { method: "PATCH", body: JSON.stringify({ tt_settings: { comment: true } }) });
    expect(noPick.status).toBe(400);
    const brandedPrivate = await call("/api/clips/t7", { method: "PATCH", body: JSON.stringify({ tt_settings: { privacy: "SELF_ONLY", brand_content: true } }) });
    expect(brandedPrivate.status).toBe(400);
  });

  it("before TikTok approves the app, a public account post waits for approval instead of becoming a lost draft", async () => {
    const hits: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      hits.push(url.replace("https://open.tiktokapis.com/v2", ""));
      if (url.endsWith("/creator_info/query/")) return Response.json({ data: { privacy_level_options: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"] }, error: { code: "ok" } });
      if (url.endsWith("/post/publish/video/init/")) return Response.json({ error: { code: "unaudited_client_can_only_post_to_private_accounts", message: "Please review our integration guidelines" } }, { status: 403 });
      return new Response("{}", { status: 404 });
    });
    await connect("tiktok");
    await duePc("t4", "tiktok");
    await call("/api/clips/t4", { method: "PATCH", body: JSON.stringify({ tt_settings: { privacy: "PUBLIC_TO_EVERYONE", comment: true } }) });
    const r = await call("/api/worker/posts/t4-tiktok/start", { method: "POST", headers: WORKER, body: JSON.stringify({ file_size: 5000 }) });
    expect(r.status).toBe(502);
    expect(hits).not.toContain("/post/publish/inbox/video/init/");
    const p = await post("t4-tiktok");
    expect(p?.status).toBe("failed");
    expect(String(p?.error)).toContain("waiting for TikTok to approve the app");
    const detail = await call("/api/clips/t4");
    expect(((await detail.json()) as { tiktok_caption: string }).tiktok_caption).toContain("#fyp");
  });

  it("a draft that only reached the inbox is not counted as posted", async () => {
    await connect("tiktok");
    await duePc("t8", "tiktok");
    await env.DB.prepare("UPDATE posts SET status = 'posting', remote_id = 'd8', posting_started_at = ? WHERE id = 't8-tiktok'").bind(new Date().toISOString()).run();
    await runDue(E, (async () => Response.json({ data: { status: "SEND_TO_USER_INBOX" }, error: { code: "ok" } })) as typeof fetch);
    const p = await post("t8-tiktok");
    expect(p?.status).toBe("failed");
    expect(String(p?.error)).toContain("not on your profile");
  });

  it("a TikTok failure is reported with its reason", async () => {
    await connect("tiktok");
    await duePc("t2", "tiktok");
    await env.DB.prepare("UPDATE posts SET status = 'posting', remote_id = 'pub2', posting_started_at = ? WHERE id = 't2-tiktok'").bind(new Date().toISOString()).run();
    const f = (async () => Response.json({ data: { status: "FAILED", fail_reason: "file_format_check_failed" }, error: { code: "ok" } })) as typeof fetch;
    await runDue(E, f);
    const p = await post("t2-tiktok");
    expect(p?.status).toBe("scheduled"); // retried
    expect(String(p?.error)).toContain("file_format_check_failed");
  });

  it("the cron leaves due TikTok and YouTube posts for the PC", async () => {
    await connect("tiktok");
    await connect("youtube");
    await duePc("t3", "tiktok");
    await duePc("t3", "youtube");
    await runDue(E, (async () => new Response("{}", { status: 500 })) as typeof fetch);
    expect((await post("t3-tiktok"))?.status).toBe("scheduled");
    expect((await post("t3-youtube"))?.status).toBe("scheduled");
  });
});

describe("connect links", () => {
  it("Google asks for offline access so posting keeps working", () => {
    const u = new URL(yt.authorizeUrl("cid", "https://app.test/cb", "st"));
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("scope")).toContain("youtube.upload");
  });
  it("TikTok connects with just the basic scopes and takes the @username from creator info", async () => {
    const f = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/oauth/token/")) return Response.json({ access_token: "a", refresh_token: "r", expires_in: 86400, open_id: "o" });
      if (url.endsWith("/creator_info/query/")) return Response.json({ data: { creator_username: "five.stars1712" }, error: { code: "ok" } });
      return Response.json({ error: { code: "scope_not_authorized", message: "The user did not authorize the scope" } }, { status: 401 });
    }) as typeof fetch;
    const r = await tt.connect(f, "ck", "cs", "https://app.test/cb", "code");
    expect(r.name).toBe("@five.stars1712");
    expect(r.tokens.open_id).toBe("o");
  });
  it("TikTok asks for the posting scopes", () => {
    const u = new URL(tt.authorizeUrl("ck", "https://app.test/cb", "st"));
    expect(u.searchParams.get("scope")).toBe("user.info.basic,video.publish,video.upload");
  });
});
