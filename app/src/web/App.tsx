import { useCallback, useEffect, useState } from "preact/hooks";
import { TikTokChoices } from "./TikTokChoices";
import { api, fmtWhen, LOGGED_OUT, media, thumbUrl, toLocalInput, type Account, type CalendarRow, type Clip, type Platform, type Post, type Settings, type Status } from "./api";

type Tab = "library" | "calendar" | "settings";

/** "scheduled" past its time means the PC has not picked it up yet */
const statusLabel = (p: Pick<Post, "status" | "scheduled_at">) =>
  p.status === "scheduled" && Date.parse(p.scheduled_at) < Date.now() ? "waiting for PC" : p.status === "posting" ? "uploading / processing" : p.status;
const PLATFORM_LABEL: Record<Platform, string> = { instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube" };

export function App() {
  const [auth, setAuth] = useState<"checking" | "in" | "out">("checking");
  useEffect(() => {
    api.me().then((r) => setAuth(r.loggedIn ? "in" : "out"), () => setAuth("out"));
    const out = () => setAuth("out");
    addEventListener(LOGGED_OUT, out);
    return () => removeEventListener(LOGGED_OUT, out);
  }, []);
  if (auth === "checking") return <p class="empty">Loading…</p>;
  if (auth === "out") return <Login onDone={() => setAuth("in")} />;
  return <Main onLogout={() => api.logout().finally(() => setAuth("out"))} />;
}

function Login({ onDone }: { onDone: () => void }) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form class="login" onSubmit={async (e) => {
      e.preventDefault();
      setBusy(true); setErr(null);
      try { await api.login(pw); onDone(); } catch (x) { setErr((x as Error).message); }
      setBusy(false);
    }}>
      <img src="/icon-192.png" alt="" width={64} height={64} />
      <h1>Autoposter</h1>
      <label>Password
        <input type="password" autoComplete="current-password" value={pw} onInput={(e) => setPw(e.currentTarget.value)} autoFocus />
      </label>
      {err && <p class="err">{err === "wrong password" ? "Wrong password." : err}</p>}
      <button class="primary" disabled={!pw || busy}>{busy ? "Checking…" : "Log in"}</button>
    </form>
  );
}

function Main({ onLogout }: { onLogout: () => void }) {
  const fromHash = (): Tab => {
    const h = location.hash.slice(1).split("?")[0];
    return h === "calendar" || h === "settings" ? h : "library";
  };
  const [tab, setTab] = useState<Tab>(fromHash);
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => { if (location.hash.slice(1).split("?")[0] !== tab) location.hash = tab; }, [tab]);
  // messages from OAuth redirects: /#settings?msg=...
  useEffect(() => {
    const m = new URLSearchParams(location.hash.split("?")[1] ?? "").get("msg");
    if (m) { setToast(m); setTimeout(() => setToast(null), 6000); history.replaceState(null, "", `#${fromHash()}`); }
  }, []);
  useEffect(() => {
    const onHash = () => setTab(fromHash());
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);
  const notify = useCallback((msg: string) => { setToast(msg); setTimeout(() => setToast(null), 3000); }, []);

  return (
    <div class="shell">
      <header>
        <h1>Autoposter</h1>
        <nav>
          {(["library", "calendar", "settings"] as Tab[]).map((t) => (
            <button class={tab === t ? "on" : ""} onClick={() => setTab(t)}>{t[0].toUpperCase() + t.slice(1)}</button>
          ))}
          <button class="link" onClick={onLogout}>Log out</button>
        </nav>
      </header>
      <main>
        {tab === "library" && <Library notify={notify} />}
        {tab === "calendar" && <Calendar notify={notify} />}
        {tab === "settings" && <SettingsPage notify={notify} />}
      </main>
      {toast && <div class="toast" role="status">{toast}</div>}
    </div>
  );
}

// ---------------- Library ----------------

function Library({ notify }: { notify: (m: string) => void }) {
  const [filter, setFilter] = useState<Status>("waiting");
  const [clips, setClips] = useState<Clip[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.clips(filter).then(setClips, (e) => setError(String(e.message ?? e)));
  }, [filter]);
  useEffect(() => { setClips(null); load(); }, [load]);

  const act = async (id: string, what: "approve" | "skip") => {
    try {
      if (what === "approve") {
        const r = await api.approve(id);
        notify(r.scheduled_at ? `Scheduled for ${fmtWhen(r.scheduled_at)}` : "Approved");
      } else {
        await api.skip(id);
        notify("Skipped");
      }
      load();
    } catch (e) { notify(`Failed: ${(e as Error).message}`); }
  };

  return (
    <section>
      <div class="filters">
        {(["waiting", "approved", "skipped"] as Status[]).map((s) => (
          <button class={filter === s ? "on" : ""} onClick={() => setFilter(s)}>
            {s === "waiting" ? "To review" : s[0].toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>
      {error && <p class="empty">Couldn't load clips: {error}</p>}
      {!error && clips === null && <p class="empty">Loading…</p>}
      {clips?.length === 0 && (
        <p class="empty">{filter === "waiting" ? "Nothing to review. New clips from the PC worker show up here." : "No clips here yet."}</p>
      )}
      <div class="grid">
        {clips?.map((c) => (
          <article class="card" key={c.id}>
            <button class="thumb" onClick={() => setOpen(c.id)} aria-label={`Open ${c.title}`}>
              {c.thumb_key ? <img src={thumbUrl(c.id, c.thumb_key)} alt="" loading="lazy" /> : <div class="noimg">No preview</div>}
              {c.duration && <span class="dur">{Math.round(c.duration)}s</span>}
            </button>
            <div class="meta">
              <span class="streamer">{c.streamer}</span>
              {c.score != null && <span class="score">{c.score.toFixed(1)}</span>}
            </div>
            <p class="title">{c.title}</p>
            {c.status === "approved" && (
              <div class="actions"><PostNowButton clipId={c.id} notify={notify} after={load} /></div>
            )}
            {c.status === "waiting" && (
              <div class="actions">
                <button class="primary" onClick={() => act(c.id, "approve")}>Approve</button>
                <PostNowButton clipId={c.id} notify={notify} after={load} />
                <button onClick={() => act(c.id, "skip")}>Skip</button>
              </div>
            )}
          </article>
        ))}
      </div>
      {open && <ClipSheet id={open} onClose={() => { setOpen(null); load(); }} notify={notify} />}
    </section>
  );
}

// ---------------- Clip detail ----------------

function ClipSheet({ id, onClose, notify }: { id: string; onClose: () => void; notify: (m: string) => void }) {
  const [clip, setClip] = useState<(Clip & { posts: Post[]; tiktok_caption?: string }) | null>(null);
  const [draft, setDraft] = useState({ title: "", caption_tiktok: "", caption_instagram: "" });
  const [when, setWhen] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api.clip(id).then((c) => {
    setClip(c);
    setDraft({ title: c.title, caption_tiktok: c.caption_tiktok, caption_instagram: c.caption_instagram });
    const next = c.posts.find((p) => p.status === "scheduled" || p.status === "failed");
    setWhen(next ? toLocalInput(next.scheduled_at) : "");
  }), [id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose]);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try { await fn(); notify(ok); await load(); } catch (e) { notify(`Failed: ${(e as Error).message}`); }
    setBusy(false);
  };
  const dirty = clip && (draft.title !== clip.title || draft.caption_tiktok !== clip.caption_tiktok || draft.caption_instagram !== clip.caption_instagram);
  const movable = clip?.posts.some((p) => p.status === "scheduled" || p.status === "failed");

  return (
    <div class="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="sheet" role="dialog" aria-modal="true" aria-label="Clip details">
        <button class="close" onClick={onClose} aria-label="Close">×</button>
        {!clip ? <p class="empty">Loading…</p> : (
          <div class="sheet-body">
            <div class="player">
              {clip.video_key
                ? <video src={media(clip.video_key)} poster={thumbUrl(clip.id, clip.thumb_key)} controls playsInline preload="metadata" />
                : (
                  <div class="pcvideo">
                    {clip.thumb_key ? <img src={thumbUrl(clip.id, clip.thumb_key)} alt="" /> : <div class="noimg">No preview</div>}
                    <p class="hint">The video stays on your PC{clip.local_path ? `: ${clip.local_path}` : ""}</p>
                  </div>
                )}
            </div>
            <div class="form">
              <p class="streamer">{clip.streamer} · <span class={`badge ${clip.status}`}>{clip.status === "waiting" ? "to review" : clip.status}</span></p>
              <label>Title (YouTube Shorts title, also used as the name)
                <input value={draft.title} maxLength={100} onInput={(e) => setDraft({ ...draft, title: e.currentTarget.value })} />
              </label>
              <label>TikTok caption
                <textarea rows={3} value={draft.caption_tiktok} onInput={(e) => setDraft({ ...draft, caption_tiktok: e.currentTarget.value })} />
              </label>
              <p class="hint">Hashtags (#GTA6, the streamer, #fyp / #Shorts…) and a credit line are added automatically when posting, so just write the hook here.</p>
              <label>Instagram caption
                <textarea rows={4} value={draft.caption_instagram} onInput={(e) => setDraft({ ...draft, caption_instagram: e.currentTarget.value })} />
              </label>
              <h3>TikTok post</h3>
              <TikTokChoices value={clip.tt_settings} title={draft.title} duration={clip.duration}
                onSave={(v) => run(() => api.save(clip.id, { tt_settings: v }), "TikTok choices saved")} />
              <div class="actions">
                <button disabled={!dirty || busy} onClick={() => run(() => api.save(clip.id, draft), "Saved")}>Save text</button>
                {clip.status !== "approved" && (
                  <button class="primary" disabled={busy} onClick={() => run(async () => {
                    if (dirty) await api.save(clip.id, draft);
                    await api.approve(clip.id);
                  }, "Approved and scheduled")}>Approve</button>
                )}
                {clip.posts.some((p) => p.status !== "posted") || clip.posts.length === 0 ? (
                  <PostNowButton clipId={clip.id} notify={notify} before={dirty ? () => api.save(clip.id, draft) : undefined} after={load} />
                ) : null}
                {clip.status !== "skipped" && (
                  <button disabled={busy} onClick={() => run(() => api.skip(clip.id), "Skipped")}>Skip</button>
                )}
              </div>

              {clip.posts.length > 0 && (
                <div class="posts">
                  <h3>Posting</h3>
                  {movable && (
                    <div class="move">
                      <input type="datetime-local" value={when} onInput={(e) => setWhen(e.currentTarget.value)} />
                      <button disabled={busy || !when} onClick={() => run(() => api.move(clip.id, new Date(when).toISOString()), "Moved")}>Move</button>
                    </div>
                  )}
                  <ul>
                    {clip.posts.map((p) => (
                      <li key={p.id}>
                        <span class={`chip ${p.platform}`}>{PLATFORM_LABEL[p.platform]}</span>
                        <span class={`badge ${p.status}`}>{statusLabel(p)}</span>
                        <span class="when">{fmtWhen(p.scheduled_at)}</span>
                        {p.remote_url && <a href={p.remote_url} target="_blank" rel="noreferrer">open</a>}
                        {p.error && <span class="err" title={p.error}>{p.error}</span>}
                        {p.platform === "tiktok" && clip.tiktok_caption && (
                          <button class="link" onClick={async () => {
                            try { await navigator.clipboard.writeText(clip.tiktok_caption!); notify("TikTok caption copied: paste it when you post the draft"); }
                            catch { notify("Could not copy: select the caption text instead"); }
                          }}>copy caption</button>
                        )}
                        {p.status === "failed" && (
                          <button class="link" disabled={busy} onClick={() => run(() => api.retry(p.id), `${PLATFORM_LABEL[p.platform]}: will try again`)}>retry</button>
                        )}
                        {(p.status === "scheduled" || p.status === "failed") && (
                          <button class="link" disabled={busy} onClick={() => run(() => api.unschedule(p.id), `Removed from ${PLATFORM_LABEL[p.platform]}`)}>remove</button>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------- Calendar ----------------

function Calendar({ notify }: { notify: (m: string) => void }) {
  const [rows, setRows] = useState<CalendarRow[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const load = useCallback(() => api.calendar().then(setRows, (e) => notify(`Couldn't load: ${e.message}`)), [notify]);
  useEffect(() => { load(); }, [load]);

  if (!rows) return <p class="empty">Loading…</p>;
  if (!rows.length) return <p class="empty">Nothing scheduled. Approve clips in the Library and they get the next free slot.</p>;

  // one entry per clip + time, with its platforms as chips
  const groups = new Map<string, { day: string; time: string; clip: CalendarRow; posts: CalendarRow[] }>();
  for (const r of rows) {
    const d = new Date(r.scheduled_at);
    const key = `${r.clip_id}|${r.scheduled_at}`;
    const g = groups.get(key) ?? {
      day: d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" }),
      time: d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
      clip: r, posts: [],
    };
    g.posts.push(r);
    groups.set(key, g);
  }
  const byDay = new Map<string, typeof groups extends Map<string, infer V> ? V[] : never>();
  for (const g of groups.values()) byDay.set(g.day, [...(byDay.get(g.day) ?? []), g]);

  return (
    <section class="calendar">
      {[...byDay.entries()].map(([day, items]) => (
        <div class="day" key={day}>
          <h2>{day}</h2>
          {items.map((g) => (
            <button class="slot" onClick={() => setOpen(g.clip.clip_id)} key={g.clip.clip_id + g.time}>
              <span class="time">{g.time}</span>
              {g.clip.thumb_key ? <img src={thumbUrl(g.clip.clip_id, g.clip.thumb_key)} alt="" loading="lazy" /> : <span class="noimg small" />}
              <span class="info">
                <span class="title">{g.clip.title}</span>
                <span class="chips">
                  {g.posts.map((p) => <span class={`chip ${p.platform} ${p.status}`} title={p.error ?? statusLabel(p)}>{PLATFORM_LABEL[p.platform]}{p.status !== "scheduled" || Date.parse(p.scheduled_at) < Date.now() ? ` · ${statusLabel(p)}` : ""}</span>)}
                </span>
              </span>
            </button>
          ))}
        </div>
      ))}
      {open && <ClipSheet id={open} onClose={() => { setOpen(null); load(); }} notify={notify} />}
    </section>
  );
}

// ---------------- Settings ----------------

/** Post now in two taps (no browser popup: some browsers and installed apps block them). */
function PostNowButton({ clipId, notify, before, after }: {
  clipId: string; notify: (m: string) => void; before?: () => Promise<unknown>; after?: () => unknown;
}) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  const go = async () => {
    if (!armed) { setArmed(true); return; }
    setArmed(false); setBusy(true);
    try {
      if (before) await before();
      const r = await api.postNow(clipId);
      notify(r.platforms.length
        ? `Posting now to ${r.platforms.map((p) => PLATFORM_LABEL[p]).join(", ")}: it goes out within about a minute${r.platforms.includes("tiktok") ? " (TikTok can take a few more minutes to process it before it shows on your profile)" : ""}`
        : "Already posted everywhere");
      await after?.();
    } catch (e) { notify(`Post now failed: ${(e as Error).message}`); }
    setBusy(false);
  };
  return (
    <button class={armed ? "primary" : ""} disabled={busy} onClick={go} title="Post right away instead of waiting for a slot">
      {busy ? "Posting…" : armed ? "Tap again to post" : "Post now"}
    </button>
  );
}

function pcStatus(seen?: string | null): string {
  if (!seen) return "The PC poster has not connected yet. Start it on your PC (pc-worker/poster.py) so due clips get uploaded.";
  const mins = Math.round((Date.now() - Date.parse(seen)) / 60_000);
  return mins <= 3 ? "PC poster is running: due clips upload within a minute." : `PC poster last checked in ${mins < 120 ? `${mins} minutes` : `${Math.round(mins / 60)} hours`} ago. Clips due while the PC is off go out when it is back on.`;
}

function Accounts({ notify }: { notify: (m: string) => void }) {
  const [list, setList] = useState<Account[] | null>(null);
  const load = useCallback(() => api.accounts().then(setList, (e) => notify(`Couldn't load accounts: ${e.message}`)), [notify]);
  useEffect(() => { load(); }, [load]);
  if (!list) return <p class="hint">Loading accounts…</p>;
  return (
    <div class="accounts">
      {list.map((a) => (
        <div class="account" key={a.platform}>
          <span class={`chip ${a.platform}`}>{PLATFORM_LABEL[a.platform]}</span>
          {a.connected ? (
            <>
              <span>{a.display_name}</span>
              {a.expires_at && <span class="hint">token renews automatically (now valid until {new Date(a.expires_at).toLocaleDateString()})</span>}
              <button class="link" onClick={async () => {
                if (!confirm(`Disconnect ${PLATFORM_LABEL[a.platform]}? Scheduled posts for it will fail until you reconnect.`)) return;
                await api.disconnect(a.platform); notify("Disconnected"); load();
              }}>disconnect</button>
            </>
          ) : a.available ? (
            <a class="button primary" href={`/api/oauth/${a.platform}/start`}>Connect</a>
          ) : (
            <span class="hint">Waiting for the {PLATFORM_LABEL[a.platform]} app keys on the server.</span>
          )}
        </div>
      ))}
    </div>
  );
}

function SettingsPage({ notify }: { notify: (m: string) => void }) {
  const [s, setS] = useState<Settings | null>(null);
  useEffect(() => { api.settings().then(setS, (e) => notify(`Couldn't load: ${e.message}`)); }, [notify]);
  if (!s) return <p class="empty">Loading…</p>;

  const save = async (next: Settings) => {
    setS(next);
    try { await api.saveSettings(next); notify("Saved"); } catch (e) { notify(`Failed: ${(e as Error).message}`); }
  };
  const valid = s.slots.every((t) => /^\d{2}:\d{2}$/.test(t)) && s.slots.length > 0;

  return (
    <section class="settings">
      <h2>Accounts</h2>
      <Accounts notify={notify} />

      <h2>TikTok default choices</h2>
      <p class="hint">Used for clips where you didn't pick TikTok choices yourself. Without them, TikTok clips are sent to your TikTok inbox as drafts.</p>
      <TikTokChoices value={s.tiktok} title="each approved clip" onSave={(v) => save({ ...s, tiktok: v })} />

      <h2>Your PC</h2>
      <p class="hint">{pcStatus(s.pc_last_seen)}</p>

      <h2>Posting times</h2>
      <p class="hint">Each approved clip takes the next free time. Times are in your time zone (Paris).</p>
      <div class="slots">
        {s.slots.map((t, i) => (
          <span class="slotedit" key={i}>
            <input type="time" value={t} onChange={(e) => {
              const slots = [...s.slots]; slots[i] = e.currentTarget.value; save({ ...s, slots: slots.sort() });
            }} />
            <button class="link" disabled={s.slots.length === 1} onClick={() => save({ ...s, slots: s.slots.filter((_, j) => j !== i) })} aria-label={`Remove ${t}`}>remove</button>
          </span>
        ))}
        <button onClick={() => save({ ...s, slots: [...s.slots, "19:00"].sort() })}>Add a time</button>
      </div>
      {!valid && <p class="err">Each time needs hours and minutes.</p>}

      <h2>Post to</h2>
      {(["instagram", "tiktok", "youtube"] as Platform[]).map((p) => (
        <label class="check" key={p}>
          <input type="checkbox" checked={s.platforms.includes(p)} onChange={(e) => save({
            ...s, platforms: e.currentTarget.checked ? [...s.platforms, p] : s.platforms.filter((x) => x !== p),
          })} />
          {PLATFORM_LABEL[p]}
        </label>
      ))}
      <p class="hint">A platform that is ticked but not connected shows the post as failed at its time, with the reason. TikTok and YouTube post as private until each platform approves the app.</p>

      <h2>Scheduling</h2>
      <label class="check">
        <input type="checkbox" checked={s.auto_schedule} onChange={(e) => save({ ...s, auto_schedule: e.currentTarget.checked })} />
        Give approved clips the next free time automatically
      </label>
    </section>
  );
}
