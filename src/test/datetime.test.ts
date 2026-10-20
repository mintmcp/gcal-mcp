import { describe, it, expect } from "vitest";
import {
  getDayOfWeek,
  formatDateTimeWithDay,
  getOffset,
  attachOffsetForTimezone,
  isValidTimeZone,
  localTimeExists,
  parseIso,
  resolveInstant,
  toInstant,
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

  it("returns an empty shape for a missing start/end (e.g. a cancelled instance)", () => {
    expect(formatDateTimeWithDay(undefined)).toEqual({ date: "", dayOfWeek: "" });
    expect(formatDateTimeWithDay(null)).toEqual({ date: "", dayOfWeek: "" });
    expect(formatDateTimeWithDay({})).toEqual({ date: "", dayOfWeek: "" });
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

  it("uses the offset in force at that wall-clock time right after a DST switch", () => {
    expect(attachOffsetForTimezone("2026-03-08T03:30:00", "America/Los_Angeles")).toBe(
      "2026-03-08T03:30:00-07:00",
    );
    expect(attachOffsetForTimezone("2026-11-01T03:30:00", "America/Los_Angeles")).toBe(
      "2026-11-01T03:30:00-08:00",
    );
  });

  it("moves a nonexistent local time in a spring-forward gap one hour later, like the Calendar UI", () => {
    // 02:30 does not exist on 2026-03-08 in LA; the clock jumps 02:00 -> 03:00.
    // Shifting forward lands on 03:30 PDT, the same instant as 02:30 PST.
    expect(attachOffsetForTimezone("2026-03-08T02:30:00", "America/Los_Angeles")).toBe(
      "2026-03-08T02:30:00-08:00",
    );
    expect(attachOffsetForTimezone("2026-03-29T01:30:00", "Europe/London")).toBe(
      "2026-03-29T01:30:00+00:00",
    );
  });

  it("appends BST for Europe/London in summer", () => {
    expect(attachOffsetForTimezone("2024-06-15T12:00:00", "Europe/London")).toBe(
      "2024-06-15T12:00:00+01:00",
    );
  });

  it("throws on unparseable naive ISO instead of silently passing through", () => {
    expect(() => attachOffsetForTimezone("not-a-date", "America/Los_Angeles")).toThrow(
      /cannot parse naive ISO/,
    );
  });

  it("throws on unparseable naive ISO even when timeZone is UTC", () => {
    expect(() => attachOffsetForTimezone("not-a-date", "UTC")).toThrow(
      /cannot parse naive ISO/,
    );
  });
});

describe("parseIso", () => {
  it("rejects a naive datetime whose calendar date does not exist", () => {
    expect(parseIso("2026-13-45T10:00:00")).toBeNull();
    expect(parseIso("2026-10-20T10:00:00")).toEqual({ kind: "datetime", rfc3339: "2026-10-20T10:00:00", hasOffset: false });
  });
});

describe("isValidTimeZone", () => {
  it("accepts IANA names and rejects made-up ones", () => {
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Not/AZone")).toBe(false);
  });
});

describe("localTimeExists", () => {
  it("reports a wall-clock time inside a spring-forward gap as nonexistent", () => {
    expect(localTimeExists("2027-03-14T02:30:00", "America/New_York")).toBe(false);
    expect(localTimeExists("2027-03-14T03:30:00", "America/New_York")).toBe(true);
    expect(localTimeExists("2027-11-07T01:30:00", "America/New_York")).toBe(true);
    expect(localTimeExists("2027-03-14T02:30:00", "UTC")).toBe(true);
  });
});

describe("toInstant", () => {
  it("anchors dates at local midnight, naive times in the zone, and keeps explicit offsets", () => {
    expect(toInstant({ kind: "date", date: "2026-10-20" }, "America/Recife")).toBe("2026-10-20T00:00:00-03:00");
    expect(toInstant({ kind: "datetime", rfc3339: "2026-10-20T10:00:00", hasOffset: false }, "America/Recife")).toBe("2026-10-20T10:00:00-03:00");
    expect(toInstant({ kind: "datetime", rfc3339: "2026-10-20T10:00:00Z", hasOffset: true }, "America/Recife")).toBe("2026-10-20T10:00:00Z");
  });

  it("only asks for the zone when the input needs one", async () => {
    let asked = 0;
    const zone = async () => { asked++; return "America/Recife"; };
    expect(await resolveInstant({ kind: "datetime", rfc3339: "2026-10-20T10:00:00Z", hasOffset: true }, zone)).toBe("2026-10-20T10:00:00Z");
    expect(asked).toBe(0);
    expect(await resolveInstant({ kind: "date", date: "2026-10-20" }, zone)).toBe("2026-10-20T00:00:00-03:00");
    expect(asked).toBe(1);
  });
});
