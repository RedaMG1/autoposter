export type Status = "waiting" | "approved" | "skipped";
export type Platform = "instagram" | "tiktok" | "youtube";

export interface Clip {
  id: string;
  streamer: string;
  title: string;
  caption_tiktok: string;
  caption_instagram: string;
  hook: string;
  video_key: string | null;
  local_path: string | null;
  thumb_key: string | null;
  duration: number | null;
  score: number | null;
  status: Status;
  created_at: string;
  tt_settings?: TtChoices | null;
}

/** The creator's choices for a TikTok post (TikTok requires them to be picked, not pre-set). */
export interface TtChoices { privacy: string; comment: boolean; duet: boolean; stitch: boolean; brand_organic: boolean; brand_content: boolean }
export interface TtCreator {
  creator_avatar_url?: string; creator_username?: string; creator_nickname?: string;
  privacy_level_options: string[]; comment_disabled?: boolean; duet_disabled?: boolean; stitch_disabled?: boolean;
  max_video_post_duration_sec?: number;
}

export interface Post {
  id: string;
  clip_id: string;
  platform: Platform;
  scheduled_at: string;
  status: "scheduled" | "posting" | "posted" | "failed";
  remote_url: string | null;
  error: string | null;
}

export interface CalendarRow extends Post { title: string; streamer: string; thumb_key: string | null }
export interface Settings { slots: string[]; platforms: Platform[]; auto_schedule: boolean; pc_last_seen?: string | null; tiktok?: TtChoices | null }

export interface Account {
  platform: Platform;
  available: boolean;
  connected: boolean;
  display_name: string | null;
  expires_at: string | null;
}

/** Fired when the server says the session is gone, so the app can show the login screen. */
export const LOGGED_OUT = "autoposter:logged-out";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: init?.body ? { "content-type": "application/json", ...init.headers } : init?.headers,
  });
  const body = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== "/api/login") dispatchEvent(new Event(LOGGED_OUT));
  if (!r.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${r.status}`);
  return body as T;
}

export const api = {
  me: () => req<{ loggedIn: boolean }>("/api/me"),
  login: (password: string) => req("/api/login", { method: "POST", body: JSON.stringify({ password }) }),
  logout: () => req("/api/logout", { method: "POST" }),
  accounts: () => req<Account[]>("/api/accounts"),
  disconnect: (p: Platform) => req(`/api/accounts/${p}`, { method: "DELETE" }),
  retry: (postId: string) => req(`/api/posts/${postId}/retry`, { method: "POST" }),
  clips: (status?: Status) => req<Clip[]>(`/api/clips${status ? `?status=${status}` : ""}`),
  clip: (id: string) => req<Clip & { posts: Post[] }>(`/api/clips/${id}`),
  tiktokCreator: () => req<TtCreator>("/api/tiktok/creator"),
  save: (id: string, fields: Partial<Pick<Clip, "title" | "caption_tiktok" | "caption_instagram" | "tt_settings">>) =>
    req(`/api/clips/${id}`, { method: "PATCH", body: JSON.stringify(fields) }),
  approve: (id: string) => req<{ scheduled_at: string | null }>(`/api/clips/${id}/approve`, { method: "POST" }),
  skip: (id: string) => req(`/api/clips/${id}/skip`, { method: "POST" }),
  postNow: (id: string) => req<{ platforms: Platform[] }>(`/api/clips/${id}/post-now`, { method: "POST" }),
  move: (id: string, scheduled_at: string) =>
    req(`/api/clips/${id}/schedule`, { method: "PATCH", body: JSON.stringify({ scheduled_at }) }),
  unschedule: (postId: string) => req(`/api/posts/${postId}`, { method: "DELETE" }),
  calendar: () => req<CalendarRow[]>("/api/calendar"),
  settings: () => req<Settings>("/api/settings"),
  saveSettings: (s: Partial<Settings>) => req("/api/settings", { method: "PUT", body: JSON.stringify(s) }),
};

export const media = (key: string | null) => (key ? `/api/media/${key}` : undefined);

/** preview image: stored in the database ("db") or, in R2 mode, in storage */
export const thumbUrl = (clipId: string, thumbKey: string | null) =>
  thumbKey === "db" ? `/api/thumb/${clipId}` : media(thumbKey);

export const fmtWhen = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** value for <input type="datetime-local"> in the viewer's time zone */
export const toLocalInput = (iso: string) => {
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};
