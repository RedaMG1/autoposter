import { describe, expect, it } from "vitest";
import { pickSlot, upcomingSlots, zonedToUtc } from "../src/worker/slots";

const TZ = "Europe/Paris";
const SLOTS = ["12:00", "17:00", "21:00"];
const at = (s: string) => Date.parse(s);

describe("zonedToUtc", () => {
  it("handles winter time (UTC+1)", () => {
    expect(zonedToUtc("2026-11-21", "12:00", TZ).toISOString()).toBe("2026-11-21T11:00:00.000Z");
  });
  it("handles summer time (UTC+2)", () => {
    expect(zonedToUtc("2026-07-01", "12:00", TZ).toISOString()).toBe("2026-07-01T10:00:00.000Z");
  });
  it("handles the day the clocks change", () => {
    // 2026-10-25: Paris goes from UTC+2 to UTC+1 at 03:00
    expect(zonedToUtc("2026-10-25", "21:00", TZ).toISOString()).toBe("2026-10-25T20:00:00.000Z");
  });
});

describe("upcomingSlots", () => {
  it("skips slots that already passed today", () => {
    const now = at("2026-11-21T12:30:00Z"); // 13:30 in Paris
    const s = upcomingSlots(now, SLOTS, TZ, 2).map((t) => new Date(t).toISOString());
    expect(s.slice(0, 3)).toEqual([
      "2026-11-21T16:00:00.000Z", "2026-11-21T20:00:00.000Z", "2026-11-22T11:00:00.000Z",
    ]);
  });
});

describe("pickSlot", () => {
  const now = at("2026-11-21T08:00:00Z"); // 09:00 Paris

  it("takes the first slot when nothing is scheduled", () => {
    expect(new Date(pickSlot(now, "Jynxzi", [], SLOTS, TZ)).toISOString()).toBe("2026-11-21T11:00:00.000Z");
  });

  it("never takes a slot that is already used", () => {
    const taken = [{ ts: at("2026-11-21T11:00:00Z"), streamer: "Lirik" }];
    expect(new Date(pickSlot(now, "Jynxzi", taken, SLOTS, TZ)).toISOString()).toBe("2026-11-21T16:00:00.000Z");
  });

  it("avoids putting the same streamer right after themselves", () => {
    const taken = [{ ts: at("2026-11-21T11:00:00Z"), streamer: "Jynxzi" }];
    // 17:00 would follow Jynxzi at 12:00, so 21:00 is chosen
    expect(new Date(pickSlot(now, "Jynxzi", taken, SLOTS, TZ)).toISOString()).toBe("2026-11-21T20:00:00.000Z");
  });

  it("skips every free slot that sits next to the same streamer", () => {
    const taken = [
      { ts: at("2026-11-21T11:00:00Z"), streamer: "Jynxzi" },
      { ts: at("2026-11-21T20:00:00Z"), streamer: "Jynxzi" },
    ];
    const got = pickSlot(now, "Jynxzi", taken, ["12:00", "17:00", "21:00"], TZ);
    // 17:00 sits between two Jynxzi posts; the next non-neighbouring free slot is tomorrow 17:00
    expect(new Date(got).toISOString()).toBe("2026-11-22T16:00:00.000Z");
  });

  it("keeps a 30 minute buffer before the first slot", () => {
    const close = at("2026-11-21T10:45:00Z"); // 11:45 Paris, 12:00 is too close
    expect(new Date(pickSlot(close, "Jynxzi", [], SLOTS, TZ)).toISOString()).toBe("2026-11-21T16:00:00.000Z");
  });
});
