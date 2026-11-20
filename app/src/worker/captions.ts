// Final post text per platform, modeled on the most-viewed GTA 6 streamer clips (Nov 2026):
//  - title = "Streamer + what happens + in GTA 6" in Title Case, ending with "!" and 1-2 emojis (💀😭👀)
//  - few, precise hashtags (streamer, game, niche); no hashtag walls
//  - TikTok/Instagram text tells the whole moment in one sentence, then a question to get comments
//  - credit the streamer
// Runs at posting time, so editing a caption in the app never loses the hashtags.

export interface CaptionClip { title: string; streamer: string; caption_instagram: string; caption_tiktok: string; source_vod?: string | null }

const HASHTAG = /(^|\s)#[\p{L}\p{N}_]+/gu;
const EMOJI = /\p{Extended_Pictographic}/u;

/** Caption without hashtags and without the old "Stream: X" credit (we add our own). */
export function cleanCaption(text: string): string {
  return text.replace(HASHTAG, " ").replace(/\bStream:\s*\S+/gi, " ").replace(/[ \t]+/g, " ")
    .split("\n").map((l) => l.trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

const tag = (s: string) => `#${s.replace(/[^\p{L}\p{N}_]/gu, "")}`;

function uniq(tags: string[]): string[] {
  const seen = new Set<string>();
  return tags.filter((t) => t.length > 1 && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()));
}

const isGta = (title: string) => /gta|grand theft/i.test(title);

/** Emojis the top clips use, picked from what happens in the title. */
export function emojiFor(title: string): string {
  const t = title.toLowerCase();
  if (/\b(dies|die|dead|kill|crash|destroy|fail|wrong|explode|run over|flatten|beaten|jumped|eaten)/.test(t)) return "💀😭";
  if (/\b(find|found|discover|secret|hidden|easter egg|first look|spots?)\b/.test(t)) return "👀";
  if (/\b(first|fastest|record|only)\b/.test(t)) return "😳🔥";
  if (/\b(thinks|says|opinion|review|rates|disappointed|refund|demands)\b/.test(t)) return "👀";
  return "😭";
}

const SMALL = new Set(["a", "an", "and", "as", "at", "but", "by", "for", "in", "of", "on", "or", "the", "to", "vs", "with", "up", "off"]);

/** Title Case that keeps names and acronyms as written (Jynxzi, xQc, GTA 6). */
export function titleCase(s: string, streamer: string): string {
  return s.split(" ").map((w, i) => {
    if (!w || w === streamer || /[A-Z].*[A-Z]|\d/.test(w) || w.startsWith(streamer)) return w;
    if (i > 0 && SMALL.has(w.toLowerCase())) return w.toLowerCase();
    return w[0].toUpperCase() + w.slice(1);
  }).join(" ");
}

/** "Jynxzi Discovers a Hidden Easter Egg in GTA 6! 👀" */
export function viralTitle(clip: Pick<CaptionClip, "title" | "streamer">, max = 100): string {
  let t = cleanCaption(clip.title).replace(/\s+/g, " ").trim();
  if (EMOJI.test(t)) return t.slice(0, max);
  t = titleCase(t, clip.streamer).replace(/[.!?]+$/, "");
  const end = `! ${emojiFor(clip.title)}`;
  return (t.length + end.length > max ? t.slice(0, max - end.length).trimEnd() : t) + end;
}

export function hashtags(platform: "instagram" | "tiktok" | "youtube", clip: CaptionClip): string[] {
  const streamer = tag(clip.streamer);
  const gta = isGta(clip.title);
  if (platform === "instagram") {
    // top Reels: 2-6 tags, game + creator + niche
    return uniq([...(gta ? ["#GTA6", "#GTA6Clips"] : []), streamer, "#TwitchClips", "#Gaming"]);
  }
  if (platform === "tiktok") {
    // top TikToks: 2-5 tags, streamer + game + clips niche
    return uniq([...(gta ? ["#GTA6"] : []), streamer, ...(gta ? ["#GTA6Clips"] : []), "#StreamerClips", "#fyp"]).slice(0, 5);
  }
  // top Shorts descriptions: #streamer #streamerfunnymoments #gta6 #shorts
  return uniq([streamer, tag(`${clip.streamer}FunnyMoments`), ...(gta ? ["#GTA6"] : []), "#Shorts"]);
}

const credit = (clip: CaptionClip) => `🎥 ${clip.streamer} on Twitch`;

/** The hook line written for the clip, used as the comment-bait after the story sentence. */
const hookFor = (platform: "instagram" | "tiktok", clip: CaptionClip) =>
  cleanCaption(platform === "tiktok" ? clip.caption_tiktok || clip.caption_instagram : clip.caption_instagram || clip.caption_tiktok);

export function finalCaption(platform: "instagram" | "tiktok", clip: CaptionClip): string {
  const story = viralTitle(clip);
  const hook = hookFor(platform, clip);
  const tags = hashtags(platform, clip).join(" ");
  const text = platform === "instagram"
    ? `${story}\n\n${hook}\n\n${credit(clip)}\n\n${tags}`
    : `${story} ${hook} ${credit(clip)} ${tags}`;
  return text.replace(/[ \t]+\n/g, "\n").slice(0, 2200);
}

/** YouTube Shorts: viral title (max 100), short description with credit and tags, and search keywords. */
export function youtubeText(clip: CaptionClip): { title: string; description: string; tags: string[] } {
  const title = viralTitle(clip);
  const lines = [title, "", credit(clip)];
  if (clip.source_vod) lines.push(`Full stream: ${clip.source_vod}`);
  lines.push("", hashtags("youtube", clip).join(" "));
  const s = clip.streamer;
  const keywords = [s, `${s} clips`, `${s} funny moments`, `${s} stream`];
  if (isGta(clip.title)) keywords.push(`${s} gta 6`, "gta 6", "gta vi", "gta 6 funny moments", "gta 6 streamer", "gta 6 gameplay", "gta 6 clips");
  return { title, description: lines.join("\n").slice(0, 4900), tags: uniq(keywords) };
}
