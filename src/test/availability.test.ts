import { describe, it, expect } from "vitest";
import { advanceToNextSlot, alignToSlotBoundary, isSlotBusy, isWithinSearchHours } from "../lib/availability.js";

describe("isWithinSearchHours", () => {
  // Monday 2024-01-15 10:00 UTC.
  const monMorning = new Date("2024-01-15T10:00:00Z");
  // Monday 2024-01-15 17:00 UTC.
  const monFivePm = new Date("2024-01-15T17:00:00Z");
  // Saturday 2024-01-13 10:00 UTC.
  const satMorning = new Date("2024-01-13T10:00:00Z");

  it("accepts a mid-window slot start", () => {
    expect(
      isWithinSearchHours(monMorning, {
        timeZone: "UTC",
        includeDays: ["Mon", "Tue", "Wed", "Thu", "Fri"],
        searchHoursStart: "09:00",
        searchHoursEnd: "17:00",
        boundary: "start",
      }),
    ).toBe(true);
  });

  it("accepts a slot end that exactly hits searchHoursEnd (boundary='end')", () => {
    // Round-2 bug fix: a 16:00-17:00 meeting must fit a "until 17:00" window.
    expect(
      isWithinSearchHours(monFivePm, {
        timeZone: "UTC",
        includeDays: ["Mon", "Tue", "Wed", "Thu", "Fri"],
        searchHoursStart: "09:00",
        searchHoursEnd: "17:00",
        boundary: "end",
      }),
    ).toBe(true);
  });

  it("rejects a slot start that exactly hits searchHoursEnd (boundary='start')", () => {
    expect(
      isWithinSearchHours(monFivePm, {
        timeZone: "UTC",
        includeDays: ["Mon", "Tue", "Wed", "Thu", "Fri"],
        searchHoursStart: "09:00",
        searchHoursEnd: "17:00",
        boundary: "start",
      }),
    ).toBe(false);
  });

  it("applies the weekday filter even when no hour window is set", () => {
    // Round-2 bug fix: includeDays must apply with or without hour bounds.
    expect(
      isWithinSearchHours(satMorning, {
        timeZone: "UTC",
        includeDays: ["Mon", "Tue", "Wed", "Thu", "Fri"],
        boundary: "start",
      }),
    ).toBe(false);
  });

  it("allows the weekday when it is explicitly in includeDays without an hour window", () => {
    expect(
      isWithinSearchHours(satMorning, {
        timeZone: "UTC",
        includeDays: ["Sat"],
        boundary: "start",
      }),
    ).toBe(true);
  });

  it("throws on malformed searchHours value instead of silently coercing", () => {
    const monMorning = new Date("2024-01-15T09:00:00Z"); // Mon UTC
    expect(() =>
      isWithinSearchHours(monMorning, {
        timeZone: "UTC",
        searchHoursStart: "9am",
        searchHoursEnd: "17:00",
        boundary: "start",
      }),
    ).toThrow(/HH:MM\[:SS\]/);
  });
});

describe("alignToSlotBoundary", () => {
  it("returns an equal time when already aligned", () => {
    const t = new Date("2024-01-15T10:00:00Z");
    expect(alignToSlotBoundary(t, 30).getTime()).toBe(t.getTime());
  });

  it("rounds up 10:07 to 10:30 on a 30-minute grid", () => {
    const t = new Date("2024-01-15T10:07:00Z");
    const out = alignToSlotBoundary(t, 30);
    expect(out.getUTCMinutes()).toBe(30);
    expect(out.getUTCSeconds()).toBe(0);
    expect(out.getUTCHours()).toBe(10);
  });

  it("rounds up 10:01 to 10:15 on a 15-minute grid", () => {
    const t = new Date("2024-01-15T10:01:00Z");
    const out = alignToSlotBoundary(t, 15);
    expect(out.getUTCMinutes()).toBe(15);
  });

  it("zeroes seconds/ms even when the minute is already on-grid", () => {
    // Regression: a now-time of 10:30:17.123 used to stay off-grid because
    // remainder=0 short-circuited the seconds/ms reset.
    const t = new Date("2024-01-15T10:30:17.123Z");
    const out = alignToSlotBoundary(t, 30);
    expect(out.getUTCHours()).toBe(10);
    expect(out.getUTCMinutes()).toBe(30);
    expect(out.getUTCSeconds()).toBe(0);
    expect(out.getUTCMilliseconds()).toBe(0);
  });

  it("does not mutate the input", () => {
    const t = new Date("2024-01-15T10:07:42Z");
    const beforeMs = t.getTime();
    alignToSlotBoundary(t, 30);
    expect(t.getTime()).toBe(beforeMs);
  });

  it("throws on non-positive incrementMinutes instead of producing NaN", () => {
    const t = new Date("2024-01-15T10:00:00Z");
    expect(() => alignToSlotBoundary(t, 0)).toThrow(/positive integer/);
    expect(() => alignToSlotBoundary(t, -15)).toThrow(/positive integer/);
    expect(() => alignToSlotBoundary(t, 1.5)).toThrow(/positive integer/);
  });
});

describe("advanceToNextSlot", () => {
  it("adds incrementMinutes", () => {
    const t = new Date("2024-01-15T10:00:00Z");
    expect(advanceToNextSlot(t, 30).toISOString()).toBe("2024-01-15T10:30:00.000Z");
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
