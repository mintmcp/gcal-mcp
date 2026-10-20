import { describe, it, expect } from "vitest";
import { addMinutes, fitsWindow, hmsToSeconds, isSlotBusy, localClock, slotStarts } from "../lib/availability.js";
import { toLocalISO } from "../lib/datetime.js";

const utc = localClock("UTC");
const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri"];
const nineToFive = { days: weekdays, startSeconds: hmsToSeconds("09:00"), endSeconds: hmsToSeconds("17:00") };
const allDay = (days: string[]) => ({ days, startSeconds: 0, endSeconds: 24 * 3600 });

describe("localClock", () => {
  it("reads weekday, minute and seconds since midnight in the given zone", () => {
    expect(localClock("Asia/Kathmandu")(new Date("2024-01-15T03:20:30Z"))).toEqual({ weekday: "Mon", seconds: 9 * 3600 + 5 * 60 + 30 });
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

describe("slotStarts", () => {
  const take = (from: string, increment: number, zone: string, count = 4) => {
    const out: string[] = [];
    for (const start of slotStarts(new Date(from), increment, zone)) {
      out.push(start.toISOString());
      if (out.length === count) break;
    }
    return out;
  };

  it("starts at the given time when it is already on the grid", () => {
    expect(take("2024-01-15T10:00:00Z", 30, "UTC", 2)).toEqual(["2024-01-15T10:00:00.000Z", "2024-01-15T10:30:00.000Z"]);
  });

  it("rounds up to the next grid point", () => {
    expect(take("2024-01-15T10:07:00Z", 30, "UTC", 1)).toEqual(["2024-01-15T10:30:00.000Z"]);
    expect(take("2024-01-15T10:01:00Z", 15, "UTC", 1)).toEqual(["2024-01-15T10:15:00.000Z"]);
  });

  it("never offers a start before the given time when it has seconds", () => {
    expect(take("2024-01-15T10:00:30Z", 30, "UTC", 1)).toEqual(["2024-01-15T10:30:00.000Z"]);
    expect(take("2024-01-15T10:30:17.123Z", 30, "UTC", 1)).toEqual(["2024-01-15T11:00:00.000Z"]);
  });

  it("counts a 45-minute grid from local midnight", () => {
    expect(take("2024-01-15T00:10:00Z", 45, "UTC")).toEqual([
      "2024-01-15T00:45:00.000Z",
      "2024-01-15T01:30:00.000Z",
      "2024-01-15T02:15:00.000Z",
      "2024-01-15T03:00:00.000Z",
    ]);
  });

  it("counts a 90-minute grid from local midnight and restarts it each day", () => {
    expect(take("2024-01-15T21:10:00Z", 90, "UTC")).toEqual([
      "2024-01-15T22:30:00.000Z",
      "2024-01-16T00:00:00.000Z",
      "2024-01-16T01:30:00.000Z",
      "2024-01-16T03:00:00.000Z",
    ]);
    expect(take("2024-01-15T23:00:00Z", 420, "UTC", 2)).toEqual(["2024-01-16T00:00:00.000Z", "2024-01-16T07:00:00.000Z"]);
  });

  it("aligns to local hours in a half-hour offset zone", () => {
    expect(take("2024-01-15T03:40:00Z", 60, "Asia/Kolkata", 2)).toEqual(["2024-01-15T04:30:00.000Z", "2024-01-15T05:30:00.000Z"]);
  });

  it("aligns to local half hours in a quarter-hour offset zone", () => {
    expect(take("2024-01-15T03:20:00Z", 30, "Asia/Kathmandu", 2)).toEqual(["2024-01-15T03:45:00.000Z", "2024-01-15T04:15:00.000Z"]);
  });

  it("skips the local times a half-hour daylight-saving shift removes", () => {
    const lordHowe = take("2024-10-06T01:50:00+10:30", 60, "Australia/Lord_Howe", 2).map((iso) => toLocalISO(new Date(iso), "Australia/Lord_Howe"));
    expect(lordHowe).toEqual(["2024-10-06T03:00:00", "2024-10-06T04:00:00"]);
  });

  it("skips the missing hour when New York springs forward", () => {
    const local = take("2024-03-10T01:00:00-05:00", 30, "America/New_York", 4).map((iso) => toLocalISO(new Date(iso), "America/New_York"));
    expect(local).toEqual(["2024-03-10T01:00:00", "2024-03-10T01:30:00", "2024-03-10T03:00:00", "2024-03-10T03:30:00"]);
  });

  it("offers the repeated hour once, at the earlier offset, when New York falls back", () => {
    expect(take("2024-11-03T00:30:00-04:00", 30, "America/New_York", 5)).toEqual([
      "2024-11-03T04:30:00.000Z",
      "2024-11-03T05:00:00.000Z",
      "2024-11-03T05:30:00.000Z",
      "2024-11-03T07:00:00.000Z",
      "2024-11-03T07:30:00.000Z",
    ]);
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
