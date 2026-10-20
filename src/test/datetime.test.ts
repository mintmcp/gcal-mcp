import { describe, it, expect } from "vitest";
import {
  getDayOfWeek,
  formatDateTimeWithDay,
  getOffset,
  attachOffsetForTimezone,
  canonicalTimeZone,
  isValidTimeZone,
  localInstant,
  parseIso,
  resolveInstant,
  toInstant,
  toZonedIso,
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

  it("resolves a wall time repeated by a fall-back change to its earlier instant in every zone", () => {
    expect(attachOffsetForTimezone("2024-11-03T01:30:00", "America/New_York")).toBe("2024-11-03T01:30:00-04:00");
    expect(attachOffsetForTimezone("2024-10-27T01:30:00", "Europe/London")).toBe("2024-10-27T01:30:00+01:00");
    expect(attachOffsetForTimezone("2024-10-27T02:30:00", "Europe/Berlin")).toBe("2024-10-27T02:30:00+02:00");
    expect(attachOffsetForTimezone("2024-04-07T02:30:00", "Pacific/Auckland")).toBe("2024-04-07T02:30:00+13:00");
    expect(attachOffsetForTimezone("2024-04-07T01:45:00", "Australia/Lord_Howe")).toBe("2024-04-07T01:45:00+11:00");
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

  it("rejects dates and times that Date.parse would roll over", () => {
    expect(parseIso("2026-02-29")).toBeNull();
    expect(parseIso("2026-04-31T10:00")).toBeNull();
    expect(parseIso("2026-02-31T10:00:00-03:00")).toBeNull();
    expect(parseIso("2026-01-01T24:00:00")).toBeNull();
    expect(parseIso("2028-02-29")).toEqual({ kind: "date", date: "2028-02-29" });
    expect(parseIso("2026-10-20T10:00:00.500Z")).toEqual({ kind: "datetime", rfc3339: "2026-10-20T10:00:00.500Z", hasOffset: true });
  });
});

describe("isValidTimeZone", () => {
  it("accepts IANA names and rejects made-up ones", () => {
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Not/AZone")).toBe(false);
  });
});

describe("canonicalTimeZone", () => {
  it("spells a valid zone the way the IANA database does", () => {
    expect(canonicalTimeZone("america/new_york")).toBe("America/New_York");
    expect(canonicalTimeZone("utc")).toBe("UTC");
  });
});

describe("localInstant", () => {
  it("returns the instant of a wall-clock time, or nothing inside a spring-forward gap", () => {
    expect(localInstant("2027-03-14T02:30:00", "America/New_York")).toBeUndefined();
    expect(localInstant("2027-03-14T03:30:00", "America/New_York")).toBe("2027-03-14T03:30:00-04:00");
    expect(localInstant("2027-11-07T01:30:00", "America/New_York")).toBe("2027-11-07T01:30:00-04:00");
    expect(localInstant("2027-03-14T02:30:00", "UTC")).toBe("2027-03-14T02:30:00Z");
  });
});

describe("toZonedIso", () => {
  it("tells the two passes through a repeated hour apart by their offsets", () => {
    expect(toZonedIso(new Date("2024-11-03T05:30:00Z"), "America/New_York")).toBe("2024-11-03T01:30:00-04:00");
    expect(toZonedIso(new Date("2024-11-03T06:30:00Z"), "America/New_York")).toBe("2024-11-03T01:30:00-05:00");
    expect(toZonedIso(new Date("2024-11-03T06:30:00Z"), "UTC")).toBe("2024-11-03T06:30:00Z");
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
