// Posting-slot logic: pure functions, no I/O, so they are easy to test.

/** UTC instant for a wall-clock date/time in an IANA time zone (handles DST). */
export function zonedToUtc(date: string, time: string, tz: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  // offset of the zone at that instant, applied twice to settle across DST edges
  let ts = guess - tzOffsetMs(guess, tz);
  ts = guess - tzOffsetMs(ts, tz);
  return new Date(ts);
}

/** Offset (ms) of `tz` from UTC at instant `ts`. */
export function tzOffsetMs(ts: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(ts));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(ts / 1000) * 1000;
}

/** Calendar date (YYYY-MM-DD) of instant `ts` in `tz`. */
export function zonedDate(ts: number, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(ts));
}

/** Upcoming slot instants (UTC ms), starting after `fromTs`, for `days` days. */
export function upcomingSlots(fromTs: number, slots: string[], tz: string, days = 60): number[] {
  const out: number[] = [];
  const start = zonedDate(fromTs, tz);
  for (let i = 0; i < days; i++) {
    const day = new Date(Date.parse(start + "T12:00:00Z") + i * 86_400_000).toISOString().slice(0, 10);
    for (const t of [...slots].sort()) {
      const ts = zonedToUtc(day, t, tz).getTime();
      if (ts > fromTs) out.push(ts);
    }
  }
  return out;
}

export interface Taken { ts: number; streamer: string }

/**
 * Earliest free slot for `streamer`, preferring one where the neighbouring taken
 * slots are a different streamer. Falls back to the earliest free slot.
 * `minLeadMs` keeps a buffer so a clip approved at 11:59 does not post at 12:00.
 */
export function pickSlot(
  nowTs: number, streamer: string, taken: Taken[], slots: string[], tz: string, minLeadMs = 30 * 60_000,
): number {
  const candidates = upcomingSlots(nowTs + minLeadMs, slots, tz);
  const busy = new Map(taken.map((t) => [t.ts, t.streamer]));
  const all = [...new Set([...candidates, ...taken.map((t) => t.ts)])].sort((a, b) => a - b);
  const free = candidates.filter((ts) => !busy.has(ts));
  const neighbourOk = (ts: number) => {
    const i = all.indexOf(ts);
    const prev = busy.get(all[i - 1]);
    const next = busy.get(all[i + 1]);
    return prev !== streamer && next !== streamer;
  };
  const best = free.find(neighbourOk) ?? free[0];
  if (best === undefined) throw new Error("no free slot in the next 60 days");
  return best;
}
