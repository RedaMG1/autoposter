// YouTube Data API v3: Google OAuth + resumable upload of Shorts (the PC sends the bytes).
// Note: until Google verifies the app, videos uploaded through the API are locked to private.

type Fetch = typeof fetch;
export const YT_SCOPES = "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly";

export interface YtTokens { access_token: string; refresh_token: string; expires_at: number; channel_id: string }

export class YtError extends Error {
  constructor(message: string, public status = 0) { super(message); }
  get permanent() { return this.status >= 400 && this.status < 500 && this.status !== 429 && this.status !== 401; }
}

async function json<T>(res: Response, what: string): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const e = body.error as { message?: string } | string | undefined;
    const msg = typeof e === "string" ? `${e}${body.error_description ? `: ${body.error_description}` : ""}` : e?.message;
    throw new YtError(`${what}: ${msg ?? `HTTP ${res.status}`}`, res.status);
  }
  return body as T;
}

export function authorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.search = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope: YT_SCOPES, state,
    access_type: "offline", prompt: "consent", include_granted_scopes: "true",
  }).toString();
  return u.toString();
}

export async function connect(f: Fetch, clientId: string, clientSecret: string, redirectUri: string, code: string, now = Date.now()) {
  const t = await json<{ access_token: string; refresh_token?: string; expires_in: number }>(
    await f("https://oauth2.googleapis.com/token", {
      method: "POST",
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, grant_type: "authorization_code", redirect_uri: redirectUri }),
    }), "token exchange");
  if (!t.refresh_token) throw new YtError("Google did not return a refresh token; remove the app's access in your Google account and connect again", 400);
  const ch = await json<{ items?: { id: string; snippet: { title: string } }[] }>(
    await f("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", { headers: { authorization: `Bearer ${t.access_token}` } }),
    "channel");
  const channel = ch.items?.[0];
  if (!channel) throw new YtError("this Google account has no YouTube channel yet: create one on youtube.com first", 400);
  return {
    tokens: { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: now + (t.expires_in - 60) * 1000, channel_id: channel.id } satisfies YtTokens,
    name: channel.snippet.title,
  };
}

/** A valid access token, refreshed when needed. Returns `changed` so the caller can save it. */
export async function fresh(f: Fetch, clientId: string, clientSecret: string, t: YtTokens, now = Date.now()) {
  if (t.expires_at > now + 60_000) return { tokens: t, changed: false };
  const r = await json<{ access_token: string; expires_in: number }>(
    await f("https://oauth2.googleapis.com/token", {
      method: "POST",
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: t.refresh_token, grant_type: "refresh_token" }),
    }), "refresh token");
  return { tokens: { ...t, access_token: r.access_token, expires_at: now + (r.expires_in - 60) * 1000 }, changed: true };
}

/** Start a resumable upload; the PC then PUTs the file to the returned address. */
/** YouTube allows about 500 characters of tags in total. */
export function fitTags(tags: string[]) {
  const out: string[] = [];
  let len = 0;
  for (const t of tags) { const n = t.length + (t.includes(" ") ? 2 : 0) + 1; if (len + n > 480) break; out.push(t); len += n; }
  return out;
}

export async function startUpload(f: Fetch, accessToken: string, size: number, title: string, description: string, privacy: string, tags: string[] = []) {
  const res = await f("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json; charset=UTF-8",
      "x-upload-content-length": String(size),
      "x-upload-content-type": "video/mp4",
    },
    body: JSON.stringify({
      snippet: { title: title.slice(0, 100), description: description.slice(0, 4900), tags: fitTags(tags), categoryId: "20" /* Gaming */ },
      status: { privacyStatus: privacy, selfDeclaredMadeForKids: false },
    }),
  });
  if (!res.ok) await json(res, "start upload");
  const uri = res.headers.get("location");
  if (!uri) throw new YtError("start upload: YouTube returned no upload address", 502);
  return uri;
}

/** Shorts: vertical and 60 s or less is enough; #Shorts in the description helps. */
export function shortsText(title: string, caption: string) {
  const desc = caption.includes("#Shorts") ? caption : `${caption}\n\n#Shorts`.trim();
  return { title, description: desc };
}
