import { useEffect, useState } from "preact/hooks";
import { api, type TtChoices, type TtCreator } from "./api";

/**
 * The choices TikTok requires before posting: who can see it (no pre-selected value),
 * comments / duet / stitch (off until turned on), commercial content disclosure,
 * and the consent line. Shows the account it will post to.
 */
const PRIVACY_LABEL: Record<string, string> = {
  PUBLIC_TO_EVERYONE: "Everyone",
  MUTUAL_FOLLOW_FRIENDS: "Friends",
  FOLLOWER_OF_CREATOR: "Followers",
  SELF_ONLY: "Only me",
};

let creatorCache: Promise<TtCreator> | null = null;
const loadCreator = () => (creatorCache ??= api.tiktokCreator().catch((e) => { creatorCache = null; throw e; }));

const EMPTY: TtChoices = { privacy: "", comment: false, duet: false, stitch: false, brand_organic: false, brand_content: false };

export function TikTokChoices({ value, onSave, duration, title }: {
  value: TtChoices | null | undefined;
  onSave: (v: TtChoices) => Promise<unknown>;
  duration?: number | null;
  title: string;
}) {
  const [creator, setCreator] = useState<TtCreator | null>(null);
  const [error, setError] = useState("");
  const [c, setC] = useState<TtChoices>(value ?? EMPTY);
  const [disclose, setDisclose] = useState(Boolean(value?.brand_organic || value?.brand_content));
  const [saved, setSaved] = useState(Boolean(value));

  useEffect(() => { loadCreator().then(setCreator, (e) => setError((e as Error).message)); }, []);
  useEffect(() => { setC(value ?? EMPTY); setDisclose(Boolean(value?.brand_organic || value?.brand_content)); setSaved(Boolean(value)); }, [value]);

  if (error) return <p class="hint">TikTok: {error}</p>;
  if (!creator) return <p class="hint">Loading your TikTok account…</p>;

  const set = (next: Partial<TtChoices>) => { setC({ ...c, ...next }); setSaved(false); };
  const tooLong = duration && creator.max_video_post_duration_sec && duration > creator.max_video_post_duration_sec;
  const discloseIncomplete = disclose && !c.brand_organic && !c.brand_content;
  const ready = Boolean(c.privacy) && !discloseIncomplete && !tooLong;
  const label = c.brand_content ? "Paid partnership" : c.brand_organic ? "Promotional content" : null;

  return (
    <div class="ttbox">
      <div class="ttwho">
        {creator.creator_avatar_url && <img src={creator.creator_avatar_url} alt="" width={36} height={36} />}
        <div>
          <strong>{creator.creator_nickname ?? "TikTok"}</strong>
          {creator.creator_username && <span class="hint"> @{creator.creator_username}</span>}
          <div class="hint">Posting “{title}” to this TikTok account</div>
        </div>
      </div>

      {tooLong ? <p class="err">This video is {Math.round(duration!)}s; your TikTok account allows up to {creator.max_video_post_duration_sec}s.</p> : null}

      <label>Who can see this video
        <select value={c.privacy} onChange={(e) => set({ privacy: e.currentTarget.value })}>
          <option value="" disabled>Choose…</option>
          {creator.privacy_level_options.map((o) => (
            <option key={o} value={o} disabled={o === "SELF_ONLY" && c.brand_content}>
              {PRIVACY_LABEL[o] ?? o}{o === "SELF_ONLY" && c.brand_content ? " (not allowed for branded content)" : ""}
            </option>
          ))}
        </select>
      </label>

      <fieldset class="ttallow">
        <legend>Allow users to</legend>
        <label class="check"><input type="checkbox" checked={c.comment && !creator.comment_disabled} disabled={creator.comment_disabled}
          onChange={(e) => set({ comment: e.currentTarget.checked })} /> Comment{creator.comment_disabled ? " (turned off in your TikTok settings)" : ""}</label>
        <label class="check"><input type="checkbox" checked={c.duet && !creator.duet_disabled} disabled={creator.duet_disabled}
          onChange={(e) => set({ duet: e.currentTarget.checked })} /> Duet{creator.duet_disabled ? " (turned off in your TikTok settings)" : ""}</label>
        <label class="check"><input type="checkbox" checked={c.stitch && !creator.stitch_disabled} disabled={creator.stitch_disabled}
          onChange={(e) => set({ stitch: e.currentTarget.checked })} /> Stitch{creator.stitch_disabled ? " (turned off in your TikTok settings)" : ""}</label>
      </fieldset>

      <label class="check"><input type="checkbox" checked={disclose} onChange={(e) => {
        const on = e.currentTarget.checked; setDisclose(on);
        if (!on) set({ brand_organic: false, brand_content: false }); else setSaved(false);
      }} /> Disclose commercial content (this video promotes a brand, product or service)</label>
      {disclose && (
        <div class="ttbrand">
          <label class="check"><input type="checkbox" checked={c.brand_organic} onChange={(e) => set({ brand_organic: e.currentTarget.checked })} /> Your brand: you are promoting yourself or your own business</label>
          <label class="check"><input type="checkbox" checked={c.brand_content} onChange={(e) => set({
            brand_content: e.currentTarget.checked, privacy: e.currentTarget.checked && c.privacy === "SELF_ONLY" ? "" : c.privacy,
          })} /> Branded content: you are promoting another brand or a third party</label>
          {discloseIncomplete ? <p class="err">Choose at least one, or turn disclosure off.</p>
            : label && <p class="hint">Your video will be labeled “{label}”.</p>}
        </div>
      )}

      <p class="hint">
        By posting, you agree to TikTok's{c.brand_content && <> <a href="https://www.tiktok.com/legal/page/global/bc-policy/en" target="_blank" rel="noreferrer">Branded Content Policy</a> and</>}{" "}
        <a href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en" target="_blank" rel="noreferrer">Music Usage Confirmation</a>.
      </p>
      <button class={saved ? "" : "primary"} disabled={!ready || saved} onClick={async () => { await onSave(c); setSaved(true); }}>
        {saved ? "TikTok choices saved" : "Save TikTok choices"}
      </button>
      {!c.privacy && <p class="hint">Pick who can see it before this clip can post to TikTok directly.</p>}
    </div>
  );
}
