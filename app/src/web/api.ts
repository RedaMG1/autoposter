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
  thumb_key: string | null;
  duration: number | null;
  score: number | null;
  status: Status;
  created_at: string;
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
export interface Settings { slots: string[]; platforms: Platform[]; auto_schedule: boolean }

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, {
    ...init,
    headers: init?.body ? { "content-type": "application/json", ...init.headers } : init?.headers,
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${r.status}`);
  return body as T;
}

export const api = {
  clips: (status?: Status) => req<Clip[]>(`/api/clips${status ? `?status=${status}` : ""}`),
  clip: (id: string) => req<Clip & { posts: Post[] }>(`/api/clips/${id}`),
  save: (id: string, fields: Partial<Pick<Clip, "title" | "caption_tiktok" | "caption_instagram">>) =>
    req(`/api/clips/${id}`, { method: "PATCH", body: JSON.stringify(fields) }),
  approve: (id: string) => req<{ scheduled_at: string | null }>(`/api/clips/${id}/approve`, { method: "POST" }),
  skip: (id: string) => req(`/api/clips/${id}/skip`, { method: "POST" }),
  move: (id: string, scheduled_at: string) =>
    req(`/api/clips/${id}/schedule`, { method: "PATCH", body: JSON.stringify({ scheduled_at }) }),
  unschedule: (postId: string) => req(`/api/posts/${postId}`, { method: "DELETE" }),
  calendar: () => req<CalendarRow[]>("/api/calendar"),
  settings: () => req<Settings>("/api/settings"),
  saveSettings: (s: Partial<Settings>) => req("/api/settings", { method: "PUT", body: JSON.stringify(s) }),
};

export const media = (key: string | null) => (key ? `/api/media/${key}` : undefined);

export const fmtWhen = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** value for <input type="datetime-local"> in the viewer's time zone */
export const toLocalInput = (iso: string) => {
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};
