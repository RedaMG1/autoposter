// Instagram API with "Unified login" (Facebook Login for Business + a configuration with an
// Instagram account asset). New Meta apps can no longer use plain Instagram login.
// The login gives a system-user token that never expires; Reels are published on graph.facebook.com.

export const IG_GRAPH = "https://graph.facebook.com/v25.0";

export interface IgTokens { access_token: string; user_id: string }
type Fetch = typeof fetch;

async function igJson<T>(res: Response, what: string): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || body.error) {
    const err = body.error as { message?: string; error_user_msg?: string } | undefined;
    const msg = err?.error_user_msg || err?.message || (body.error_message as string) || `HTTP ${res.status}`;
    throw new IgError(`${what}: ${msg}`, res.status);
  }
  return body as T;
}

export class IgError extends Error {
  constructor(message: string, public status = 0) { super(message); }
  /** 4xx (except 429) means our request is wrong: retrying will not help. */
  get permanent() { return this.status >= 400 && this.status < 500 && this.status !== 429; }
}

/** The login link Meta generates for the app's configuration (Facebook Login for Business). */
export function authorizeUrl(appId: string, configId: string, redirectUri: string, state: string): string {
  const u = new URL("https://www.facebook.com/v25.0/dialog/oauth");
  u.search = new URLSearchParams({
    client_id: appId, config_id: configId, redirect_uri: redirectUri, response_type: "code",
    override_default_response_type: "true", state,
  }).toString();
  return u.toString();
}

/** code -> system-user token (never expires) + the Instagram account it was granted for. */
export async function connect(f: Fetch, appId: string, appSecret: string, redirectUri: string, code: string) {
  const tok = await igJson<{ access_token: string; expires_in?: number }>(
    await f(`${IG_GRAPH}/oauth/access_token?${new URLSearchParams({
      client_id: appId, client_secret: appSecret, redirect_uri: redirectUri, code,
    })}`), "token exchange");
  // which Instagram account did the person pick? debug_token lists the granted asset ids per permission
  const dbg = await igJson<{ data: { granular_scopes?: { scope: string; target_ids?: string[] }[] } }>(
    await f(`${IG_GRAPH}/debug_token?${new URLSearchParams({
      input_token: tok.access_token, access_token: `${appId}|${appSecret}`,
    })}`), "check token");
  const scopes = dbg.data.granular_scopes ?? [];
  const igId = (scopes.find((s) => s.scope === "instagram_content_publish")?.target_ids
    ?? scopes.find((s) => s.scope === "instagram_basic")?.target_ids ?? [])[0];
  if (!igId) throw new IgError("no Instagram account was selected during login (it must be a Creator or Business account)", 400);
  const me = await igJson<{ id: string; username: string }>(
    await f(`${IG_GRAPH}/${igId}?fields=id,username&access_token=${encodeURIComponent(tok.access_token)}`), "profile");
  return {
    tokens: { access_token: tok.access_token, user_id: me.id } satisfies IgTokens,
    username: me.username,
    // system-user tokens from this configuration never expire
    expires_at: tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000).toISOString() : null,
  };
}

export async function refresh(f: Fetch, token: string) {
  const r = await igJson<{ access_token: string; expires_in: number }>(
    await f(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token)}`),
    "refresh token");
  return { access_token: r.access_token, expires_at: new Date(Date.now() + r.expires_in * 1000).toISOString() };
}

/** Step 1: create a Reels container; Instagram downloads the video from `videoUrl`. */
export async function createReel(f: Fetch, t: IgTokens, videoUrl: string, caption: string): Promise<string> {
  const r = await igJson<{ id: string }>(await f(`${IG_GRAPH}/${t.user_id}/media`, {
    method: "POST",
    body: new URLSearchParams({
      media_type: "REELS", video_url: videoUrl, caption: caption.slice(0, 2200), share_to_feed: "true",
      access_token: t.access_token,
    }),
  }), "create reel");
  return r.id;
}

/**
 * Step 1 (video on the PC): create a Reels container for a resumable upload.
 * The PC then sends the file to `uri` with headers `Authorization: OAuth <token>`,
 * `offset: 0` and `file_size: <bytes>`.
 */
export async function createReelResumable(f: Fetch, t: IgTokens, caption: string): Promise<{ id: string; uri: string }> {
  return igJson<{ id: string; uri: string }>(await f(`${IG_GRAPH}/${t.user_id}/media`, {
    method: "POST",
    body: new URLSearchParams({
      media_type: "REELS", upload_type: "resumable", caption: caption.slice(0, 2200), share_to_feed: "true",
      access_token: t.access_token,
    }),
  }), "create reel");
}

export type ContainerState = "IN_PROGRESS" | "FINISHED" | "ERROR" | "EXPIRED" | "PUBLISHED";

/** Step 2: wait until Instagram has processed the video. */
export async function containerStatus(f: Fetch, t: IgTokens, containerId: string) {
  return igJson<{ status_code: ContainerState; status?: string }>(
    await f(`${IG_GRAPH}/${containerId}?fields=status_code,status&access_token=${encodeURIComponent(t.access_token)}`),
    "check processing");
}

/** Step 3: publish, then fetch the public link. */
export async function publish(f: Fetch, t: IgTokens, containerId: string) {
  const r = await igJson<{ id: string }>(await f(`${IG_GRAPH}/${t.user_id}/media_publish`, {
    method: "POST",
    body: new URLSearchParams({ creation_id: containerId, access_token: t.access_token }),
  }), "publish");
  let permalink: string | null = null;
  try {
    permalink = (await igJson<{ permalink: string }>(
      await f(`${IG_GRAPH}/${r.id}?fields=permalink&access_token=${encodeURIComponent(t.access_token)}`), "permalink")).permalink;
  } catch { /* the post is live; the link is optional */ }
  return { mediaId: r.id, permalink };
}
