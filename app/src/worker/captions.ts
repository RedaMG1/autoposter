// Final post text per platform: your caption + a credit line + hashtags chosen for reach.
// Runs at posting time, so editing a caption in the app never loses the hashtags.

export interface CaptionClip { title: string; streamer: string; caption_instagram: string; caption_tiktok: string; source_vod?: string | null }

const HASHTAG = /(^|\s)#[\p{L}\p{N}_]+/gu;

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

/** Topic tags from the title (GTA 6 now; other games later). */
function topicTags(title: string): string[] {
  if (/gta|grand theft/i.test(title)) return ["#GTA6", "#GTAVI", "#GTA"];
  return [];
}

export function hashtags(platform: "instagram" | "tiktok" | "youtube", clip: CaptionClip): string[] {
  const streamer = tag(clip.streamer);
  const topic = topicTags(clip.title);
  if (platform === "instagram") {
    // 6-8 focused tags work best on Reels: topic, creator, niche, format
    return uniq([...topic, streamer, "#Gaming", "#GamingClips", "#TwitchClips", "#StreamerMoments", "#Reels"]).slice(0, 9);
  }
  if (platform === "tiktok") {
    // TikTok: 3-5 relevant tags; #fyp helps new accounts get tested
    return uniq([...topic.slice(0, 2), streamer, "#Gaming", "#fyp"]).slice(0, 5);
  }
  return uniq(["#Shorts", ...topic.slice(0, 2), streamer, "#Gaming"]).slice(0, 5);
}

const credit = (clip: CaptionClip) => `🎥 ${clip.streamer} on Twitch`;

export function finalCaption(platform: "instagram" | "tiktok", clip: CaptionClip): string {
  const base = cleanCaption(platform === "tiktok" ? clip.caption_tiktok || clip.caption_instagram : clip.caption_instagram || clip.caption_tiktok);
  const tags = hashtags(platform, clip).join(" ");
  const text = platform === "instagram" ? `${base}\n\n${credit(clip)}\n\n${tags}` : `${base} ${credit(clip)} ${tags}`;
  return text.slice(0, 2200);
}

/** YouTube Shorts: title (max 100) + description with credit, stream link and tags. */
export function youtubeText(clip: CaptionClip): { title: string; description: string } {
  const tags = hashtags("youtube", clip);
  let title = clip.title.trim();
  if (title.length + 8 <= 100) title = `${title} #Shorts`;
  const lines = [cleanCaption(clip.caption_instagram || clip.caption_tiktok), "", credit(clip)];
  if (clip.source_vod) lines.push(`Full stream: ${clip.source_vod}`);
  lines.push("", tags.join(" "));
  return { title: title.slice(0, 100), description: lines.join("\n").slice(0, 4900) };
}
