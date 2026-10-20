import { describe, it, expect } from "vitest";
import { addMinutes, alignToSlotBoundary, fitsWindow, hmsToSeconds, isSlotBusy, localClock } from "../lib/availability.js";

const utc = localClock("UTC");
const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri"];
const nineToFive = { days: weekdays, startSeconds: hmsToSeconds("09:00"), endSeconds: hmsToSeconds("17:00") };
const allDay = (days: string[]) => ({ days, startSeconds: 0, endSeconds: 24 * 3600 });

describe("localClock", () => {
  it("reads weekday, minute and seconds since midnight in the given zone", () => {
    expect(localClock("Asia/Kathmandu")(new Date("2024-01-15T03:20:30Z"))).toEqual({ weekday: "Mon", minute: 5, seconds: 9 * 3600 + 5 * 60 + 30 });
  });
});

describe("hmsToSeconds", () => {
  it("accepts HH:MM and HH:MM:SS", () => {
    expect(hmsToSeconds("09:30")).toBe(34_200);
    expect(hmsToSeconds("09:30:15")).toBe(34_215);
  });
});

describe("fitsWindow", () => {
  const at = (iso: string) => utc(new Date(iso));

  it("accepts a slot inside the window", () => {
    expect(fitsWindow(at("2024-01-15T10:00:00Z"), at("2024-01-15T11:00:00Z"), nineToFive)).toBe(true);
  });

  it("accepts a slot that ends exactly at the window end", () => {
    expect(fitsWindow(at("2024-01-15T16:00:00Z"), at("2024-01-15T17:00:00Z"), nineToFive)).toBe(true);
  });

  it("rejects a slot that starts exactly at the window end", () => {
    expect(fitsWindow(at("2024-01-15T17:00:00Z"), at("2024-01-15T17:30:00Z"), nineToFive)).toBe(false);
  });

  it("applies the weekday filter even when no hour window is set", () => {
    expect(fitsWindow(at("2024-01-13T10:00:00Z"), at("2024-01-13T11:00:00Z"), allDay(weekdays))).toBe(false);
    expect(fitsWindow(at("2024-01-13T10:00:00Z"), at("2024-01-13T11:00:00Z"), allDay(["Sat"]))).toBe(true);
  });

  it("rejects a slot whose end spills into an excluded day", () => {
    expect(fitsWindow(at("2024-01-12T23:30:00Z"), at("2024-01-13T00:30:00Z"), allDay(weekdays))).toBe(false);
  });
});

describe("alignToSlotBoundary", () => {
  it("returns an equal time when already aligned", () => {
    const t = new Date("2024-01-15T10:00:00Z");
    expect(alignToSlotBoundary(t, 30, utc).getTime()).toBe(t.getTime());
  });

  it("rounds up 10:07 to 10:30 on a 30-minute grid", () => {
    expect(alignToSlotBoundary(new Date("2024-01-15T10:07:00Z"), 30, utc).toISOString()).toBe("2024-01-15T10:30:00.000Z");
  });

  it("rounds up 10:01 to 10:15 on a 15-minute grid", () => {
    expect(alignToSlotBoundary(new Date("2024-01-15T10:01:00Z"), 15, utc).toISOString()).toBe("2024-01-15T10:15:00.000Z");
  });

  it("zeroes seconds and milliseconds even when the minute is already on the grid", () => {
    expect(alignToSlotBoundary(new Date("2024-01-15T10:30:17.123Z"), 30, utc).toISOString()).toBe("2024-01-15T10:30:00.000Z");
  });

  it("does not mutate the input", () => {
    const t = new Date("2024-01-15T10:07:42Z");
    alignToSlotBoundary(t, 30, utc);
    expect(t.toISOString()).toBe("2024-01-15T10:07:42.000Z");
  });

  it("aligns to local hours in a half-hour offset zone", () => {
    const kolkata = localClock("Asia/Kolkata");
    const out = alignToSlotBoundary(new Date("2024-01-15T03:40:00Z"), 60, kolkata);
    expect(out.toISOString()).toBe("2024-01-15T04:30:00.000Z");
    expect(kolkata(out).minute).toBe(0);
  });

  it("aligns to local half hours in a quarter-hour offset zone", () => {
    const kathmandu = localClock("Asia/Kathmandu");
    const out = alignToSlotBoundary(new Date("2024-01-15T03:20:00Z"), 30, kathmandu);
    expect(out.toISOString()).toBe("2024-01-15T03:45:00.000Z");
    expect(kathmandu(out).minute).toBe(30);
  });
});

describe("addMinutes", () => {
  it("adds minutes without mutating the input", () => {
    const t = new Date("2024-01-15T10:00:00Z");
    expect(addMinutes(t, 30).toISOString()).toBe("2024-01-15T10:30:00.000Z");
    expect(t.toISOString()).toBe("2024-01-15T10:00:00.000Z");
  });
});

describe("isSlotBusy", () => {
  const busy = [
    {
      start: new Date("2024-01-15T10:00:00Z"),
      end: new Date("2024-01-15T11:00:00Z"),
    },
  ];

  it("returns false when slot is entirely before busy", () => {
    expect(
      isSlotBusy(
        new Date("2024-01-15T09:00:00Z"),
        new Date("2024-01-15T10:00:00Z"),
        busy,
      ),
    ).toBe(false);
  });

  it("returns true when slot partially overlaps busy", () => {
    expect(
      isSlotBusy(
        new Date("2024-01-15T10:30:00Z"),
        new Date("2024-01-15T11:30:00Z"),
        busy,
      ),
    ).toBe(true);
  });

  it("returns false when slot is entirely after busy", () => {
    expect(
      isSlotBusy(
        new Date("2024-01-15T11:00:00Z"),
        new Date("2024-01-15T12:00:00Z"),
        busy,
      ),
    ).toBe(false);
  });

  it("returns true when slot contains busy", () => {
    expect(
      isSlotBusy(
        new Date("2024-01-15T09:00:00Z"),
        new Date("2024-01-15T12:00:00Z"),
        busy,
      ),
    ).toBe(true);
  });
});
