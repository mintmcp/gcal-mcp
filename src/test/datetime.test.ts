import { describe, it, expect } from "vitest";
import {
  getDayOfWeek,
  formatDateTimeWithDay,
  getOffset,
  attachOffsetForTimezone,
  normalizeAttendees,
  isWithinSearchHours,
  alignToSlotBoundary,
  advanceToNextSlot,
  isSlotBusy,
} from "../lib/datetime.js";

describe("getDayOfWeek", () => {
  it("returns the day for an all-day date", () => {
    // 2024-01-15 is a Monday.
    expect(getDayOfWeek("2024-01-15")).toBe("Mon");
  });

  it("reports the wall-clock day, not the UTC-shifted day, for zone-aware datetimes", () => {
    // 2024-01-15T23:00:00-08:00 is 2024-01-16T07:00Z. Old behaviour would report Tue.
    // Fixed behaviour: report Mon (the day the event sits on the user's calendar).
    expect(getDayOfWeek("2024-01-15T23:00:00-08:00")).toBe("Mon");
  });

  it("returns empty string for unparseable input", () => {
    expect(getDayOfWeek("not-a-date")).toBe("");
  });
});

describe("formatDateTimeWithDay", () => {
  it("preserves the wall-clock date/time for zone-aware datetimes with offset", () => {
    expect(formatDateTimeWithDay({ dateTime: "2024-01-15T23:00:00-08:00" })).toEqual({
      date: "2024-01-15",
      time: "23:00:00",
      dayOfWeek: "Mon",
      timezone: "-08:00",
    });
  });

  it("preserves Z-suffix timezones", () => {
    expect(formatDateTimeWithDay({ dateTime: "2024-03-10T07:30:00Z" })).toEqual({
      date: "2024-03-10",
      time: "07:30:00",
      dayOfWeek: "Sun",
      timezone: "Z",
    });
  });

  it("handles all-day events (date only, no time, no timezone)", () => {
    const out = formatDateTimeWithDay({ date: "2024-03-10" });
    expect(out.date).toBe("2024-03-10");
    expect(out.dayOfWeek).toBe("Sun");
    expect(out.time).toBeUndefined();
    expect(out.timezone).toBeUndefined();
  });
});

describe("getOffset", () => {
  it("returns 'Z' for UTC", () => {
    expect(getOffset("UTC")).toBe("Z");
  });

  it("returns -08:00 for Los Angeles in January (standard time)", () => {
    expect(getOffset("America/Los_Angeles", new Date("2024-01-15T12:00:00Z"))).toBe(
      "-08:00",
    );
  });

  it("returns -07:00 for Los Angeles in July (daylight time)", () => {
    expect(getOffset("America/Los_Angeles", new Date("2024-07-15T12:00:00Z"))).toBe(
      "-07:00",
    );
  });

  it("returns +01:00 for Europe/London during BST", () => {
    expect(getOffset("Europe/London", new Date("2024-06-15T12:00:00Z"))).toBe(
      "+01:00",
    );
  });
});

describe("attachOffsetForTimezone", () => {
  it("appends Z for UTC", () => {
    expect(attachOffsetForTimezone("2024-01-15T09:00:00", "UTC")).toBe(
      "2024-01-15T09:00:00Z",
    );
  });

  it("appends the LA winter offset", () => {
    expect(attachOffsetForTimezone("2024-01-15T09:00:00", "America/Los_Angeles")).toBe(
      "2024-01-15T09:00:00-08:00",
    );
  });

  it("appends the LA summer offset (DST)", () => {
    expect(attachOffsetForTimezone("2024-07-15T09:00:00", "America/Los_Angeles")).toBe(
      "2024-07-15T09:00:00-07:00",
    );
  });

  it("appends BST for Europe/London in summer", () => {
    expect(attachOffsetForTimezone("2024-06-15T12:00:00", "Europe/London")).toBe(
      "2024-06-15T12:00:00+01:00",
    );
  });
});

describe("normalizeAttendees", () => {
  it("returns undefined for undefined input", () => {
    expect(normalizeAttendees(undefined)).toBeUndefined();
  });

  it("returns empty array for empty input", () => {
    expect(normalizeAttendees([])).toEqual([]);
  });

  it("normalises bare email strings to { email }", () => {
    expect(normalizeAttendees(["a@x.com", "b@x.com"])).toEqual([
      { email: "a@x.com" },
      { email: "b@x.com" },
    ]);
  });

  it("preserves displayName and optional=true when set", () => {
    expect(
      normalizeAttendees([
        { email: "a@x.com", displayName: "Alice", optional: true },
      ]),
    ).toEqual([{ email: "a@x.com", displayName: "Alice", optional: true }]);
  });

  it("omits optional when it is false (only sets when truly true)", () => {
    expect(
      normalizeAttendees([{ email: "a@x.com", optional: false }]),
    ).toEqual([{ email: "a@x.com" }]);
  });

  it("omits empty displayName", () => {
    expect(
      normalizeAttendees([{ email: "a@x.com", displayName: "" }]),
    ).toEqual([{ email: "a@x.com" }]);
  });

  it("mixes bare emails and objects in one list", () => {
    expect(
      normalizeAttendees(["a@x.com", { email: "b@x.com", displayName: "B" }]),
    ).toEqual([{ email: "a@x.com" }, { email: "b@x.com", displayName: "B" }]);
  });
});

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
