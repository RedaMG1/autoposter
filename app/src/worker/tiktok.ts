// TikTok Content Posting API (Direct Post) with Login Kit OAuth. The PC sends the video bytes.
// Until TikTok audits the app, posts can only be private (SELF_ONLY).

type Fetch = typeof fetch;
export const TT_SCOPES = "user.info.basic,video.publish,video.upload";
const API = "https://open.tiktokapis.com/v2";

export interface TtTokens { access_token: string; refresh_token: string; expires_at: number; open_id: string }

export class TtError extends Error {
  constructor(message: string, public status = 0, public code = "") { super(message); }
  get permanent() {
    return (this.status >= 400 && this.status < 500 && this.status !== 429 && this.status !== 401) ||
      ["spam_risk_too_many_posts", "unaudited_client_can_only_post_to_private_accounts", "privacy_level_option_mismatch"].includes(this.code);
  }
}

async function json<T>(res: Response, what: string): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as { data?: T; error?: { code?: string; message?: string } } & Record<string, unknown>;
  const code = body.error?.code;
  if (!res.ok || (code && code !== "ok")) {
    const msg = body.error?.message || (body.error_description as string) || code || `HTTP ${res.status}`;
    throw new TtError(`${what}: ${msg}`, res.status, code ?? "");
  }
  return (body.data ?? body) as T;
}

export function authorizeUrl(clientKey: string, redirectUri: string, state: string): string {
  const u = new URL("https://www.tiktok.com/v2/auth/authorize/");
  u.search = new URLSearchParams({ client_key: clientKey, scope: TT_SCOPES, response_type: "code", redirect_uri: redirectUri, state }).toString();
  return u.toString();
}

async function token(f: Fetch, body: Record<string, string>) {
  const r = await f(`${API}/oauth/token/`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body),
  });
  const j = (await r.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; open_id?: string; error?: string; error_description?: string };
  if (!r.ok || !j.access_token) throw new TtError(`token: ${j.error_description || j.error || `HTTP ${r.status}`}`, r.status || 400, j.error ?? "");
  return j as Required<Pick<typeof j, "access_token" | "refresh_token" | "expires_in" | "open_id">>;
}

export async function connect(f: Fetch, clientKey: string, clientSecret: string, redirectUri: string, code: string, now = Date.now()) {
  const t = await token(f, { client_key: clientKey, client_secret: clientSecret, code, grant_type: "authorization_code", redirect_uri: redirectUri });
  // The @username comes from creator info (video.publish scope); user/info only gives the display name
  // without the extra user.info.profile scope. Neither is required to connect.
  const auth = { authorization: `Bearer ${t.access_token}`, "content-type": "application/json; charset=UTF-8" };
  let name = "TikTok";
  try {
    const c = await json<{ creator_username?: string; creator_nickname?: string }>(
      await f(`${API}/post/publish/creator_info/query/`, { method: "POST", headers: auth, body: "{}" }), "creator");
    if (c.creator_username) name = `@${c.creator_username}`;
    else if (c.creator_nickname) name = c.creator_nickname;
  } catch {
    try {
      const me = await json<{ user: { display_name?: string } }>(
        await f(`${API}/user/info/?fields=display_name`, { headers: { authorization: auth.authorization } }), "profile");
      if (me.user.display_name) name = me.user.display_name;
    } catch { /* keep the default name */ }
  }
  return {
    tokens: { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: now + (t.expires_in - 60) * 1000, open_id: t.open_id } satisfies TtTokens,
    name,
  };
}

export async function fresh(f: Fetch, clientKey: string, clientSecret: string, t: TtTokens, now = Date.now()) {
  if (t.expires_at > now + 60_000) return { tokens: t, changed: false };
  const r = await token(f, { client_key: clientKey, client_secret: clientSecret, grant_type: "refresh_token", refresh_token: t.refresh_token });
  return { tokens: { ...t, access_token: r.access_token, refresh_token: r.refresh_token ?? t.refresh_token, expires_at: now + (r.expires_in - 60) * 1000 }, changed: true };
}

const MB = 1024 * 1024;
/** TikTok wants chunks of 5-64 MB, all equal except the last (which may be up to 128 MB). */
export function chunking(size: number) {
  if (size <= 64 * MB) return { chunk_size: size, total_chunk_count: 1 };
  const chunk = 10 * MB;
  return { chunk_size: chunk, total_chunk_count: Math.floor(size / chunk) };
}

/** Pick the most public option TikTok allows for this account/app (private until audited). */
export async function privacyFor(f: Fetch, accessToken: string, wanted: string) {
  const info = await json<{ privacy_level_options: string[]; max_video_post_duration_sec?: number }>(
    await f(`${API}/post/publish/creator_info/query/`, {
      method: "POST", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json; charset=UTF-8" },
    }), "creator info");
  const options = info.privacy_level_options ?? [];
  return options.includes(wanted) ? wanted : options.includes("SELF_ONLY") ? "SELF_ONLY" : options[0] ?? "SELF_ONLY";
}

export async function initUpload(f: Fetch, accessToken: string, size: number, caption: string, privacy: string) {
  const { chunk_size, total_chunk_count } = chunking(size);
  const d = await json<{ publish_id: string; upload_url: string }>(
    await f(`${API}/post/publish/video/init/`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json; charset=UTF-8" },
      body: JSON.stringify({
        post_info: { title: caption.slice(0, 2200), privacy_level: privacy, disable_comment: false, disable_duet: false, disable_stitch: false },
        source_info: { source: "FILE_UPLOAD", video_size: size, chunk_size, total_chunk_count },
      }),
    }), "start upload");
  return { publish_id: d.publish_id, upload_url: d.upload_url, chunk_size, total_chunk_count };
}

/** Direct posting refused because the app is not audited yet and the account is public. */
export const isUnaudited = (e: unknown) =>
  e instanceof TtError && (e.code === "unaudited_client_can_only_post_to_private_accounts" || /integration guidelines/i.test(e.message));

/** Send the video to the creator's TikTok inbox as a draft (works before the audit, on public accounts). */
export async function initInbox(f: Fetch, accessToken: string, size: number) {
  const { chunk_size, total_chunk_count } = chunking(size);
  const d = await json<{ publish_id: string; upload_url: string }>(
    await f(`${API}/post/publish/inbox/video/init/`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ source_info: { source: "FILE_UPLOAD", video_size: size, chunk_size, total_chunk_count } }),
    }), "send to inbox");
  return { publish_id: d.publish_id, upload_url: d.upload_url, chunk_size, total_chunk_count };
}

export type TtStatus = "PROCESSING_UPLOAD" | "PROCESSING_DOWNLOAD" | "SEND_TO_USER_INBOX" | "PUBLISH_COMPLETE" | "FAILED";

export async function status(f: Fetch, accessToken: string, publishId: string) {
  return json<{ status: TtStatus; fail_reason?: string; publicaly_available_post_id?: (string | number)[] }>(
    await f(`${API}/post/publish/status/fetch/`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ publish_id: publishId }),
    }), "check status");
}
