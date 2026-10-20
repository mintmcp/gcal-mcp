import { describe, it, expect } from "vitest";
import { addMinutes, busyChecker, fitsWindow, hmsToSeconds, localClock, mergeIntervals, slotStarts } from "../lib/availability.js";
import { toLocalISO } from "../lib/datetime.js";

const utc = localClock("UTC");
const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri"];
const nineToFive = { days: weekdays, startSeconds: hmsToSeconds("09:00"), endSeconds: hmsToSeconds("17:00") };
const allDay = (days: string[]) => ({ days, startSeconds: 0, endSeconds: 24 * 3600 });

describe("localClock", () => {
  it("reads the local date and seconds since midnight in the given zone", () => {
    expect(localClock("Asia/Kathmandu")(new Date("2024-01-15T03:20:30Z"))).toEqual({ date: "2024-01-15", seconds: 9 * 3600 + 5 * 60 + 30 });
  });
});

describe("hmsToSeconds", () => {
  it("accepts HH:MM and HH:MM:SS", () => {
    expect(hmsToSeconds("09:30")).toBe(34_200);
    expect(hmsToSeconds("09:30:15")).toBe(34_215);
  });
});

describe("fitsWindow", () => {
  const slot = (start: string, end: string) => ({ start: new Date(start), end: new Date(end) });

  it("keeps a slot that crosses a fall-back fold inside the window for its whole length", () => {
    const sunday = (start: string, end: string) => ({ days: ["Sun"], startSeconds: hmsToSeconds(start), endSeconds: hmsToSeconds(end) });
    const ny = localClock("America/New_York");
    const london = localClock("Europe/London");
    expect(fitsWindow(slot("2026-11-01T01:30:00-04:00", "2026-11-01T01:30:00-05:00"), ny, sunday("00:30", "01:30"))).toBe(false);
    expect(fitsWindow(slot("2026-11-01T01:00:00-04:00", "2026-11-01T01:00:00-05:00"), ny, sunday("00:30", "01:30"))).toBe(false);
    expect(fitsWindow(slot("2026-11-01T01:45:00-04:00", "2026-11-01T01:15:00-05:00"), ny, sunday("01:30", "02:00"))).toBe(false);
    expect(fitsWindow(slot("2026-10-25T01:45:00+01:00", "2026-10-25T01:45:00+00:00"), london, sunday("01:30", "02:30"))).toBe(false);
    expect(fitsWindow(slot("2026-11-01T01:00:00-04:00", "2026-11-01T01:00:00-05:00"), ny, sunday("00:00", "02:00"))).toBe(true);
  });

  it("accepts a slot inside the window", () => {
    expect(fitsWindow(slot("2024-01-15T10:00:00Z", "2024-01-15T11:00:00Z"), utc, nineToFive)).toBe(true);
  });

  it("accepts a slot that ends exactly at the window end", () => {
    expect(fitsWindow(slot("2024-01-15T16:00:00Z", "2024-01-15T17:00:00Z"), utc, nineToFive)).toBe(true);
  });

  it("rejects a slot that starts exactly at the window end", () => {
    expect(fitsWindow(slot("2024-01-15T17:00:00Z", "2024-01-15T17:30:00Z"), utc, nineToFive)).toBe(false);
  });

  it("applies the weekday filter even when no hour window is set", () => {
    expect(fitsWindow(slot("2024-01-13T10:00:00Z", "2024-01-13T11:00:00Z"), utc, allDay(weekdays))).toBe(false);
    expect(fitsWindow(slot("2024-01-13T10:00:00Z", "2024-01-13T11:00:00Z"), utc, allDay(["Sat"]))).toBe(true);
  });

  it("rejects a slot whose end spills into an excluded day", () => {
    expect(fitsWindow(slot("2024-01-12T23:30:00Z", "2024-01-13T00:30:00Z"), utc, allDay(weekdays))).toBe(false);
  });

  it("rejects a slot that crosses into the next day of a bounded window", () => {
    expect(fitsWindow(slot("2026-10-19T09:00:00Z", "2026-10-20T09:00:00Z"), utc, nineToFive)).toBe(false);
  });

  it("rejects an unrestricted multi-day slot that spans an excluded weekday", () => {
    expect(fitsWindow(slot("2024-01-12T12:00:00Z", "2024-01-15T12:00:00Z"), utc, allDay(weekdays))).toBe(false);
    expect(fitsWindow(slot("2024-01-15T12:00:00Z", "2024-01-18T12:00:00Z"), utc, allDay(weekdays))).toBe(true);
  });

  it("does not count the next day for a slot ending exactly at local midnight", () => {
    expect(fitsWindow(slot("2024-01-12T23:00:00Z", "2024-01-13T00:00:00Z"), utc, allDay(weekdays))).toBe(true);
    expect(fitsWindow(slot("2024-01-11T12:00:00Z", "2024-01-13T00:00:00Z"), utc, allDay(weekdays))).toBe(true);
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

  it("offers the repeated hour once, at the earlier offset, when London falls back", () => {
    expect(take("2024-10-27T00:30:00+01:00", 30, "Europe/London", 4)).toEqual([
      "2024-10-26T23:30:00.000Z",
      "2024-10-27T00:00:00.000Z",
      "2024-10-27T00:30:00.000Z",
      "2024-10-27T02:00:00.000Z",
    ]);
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

describe("mergeIntervals", () => {
  const at = (h: number) => new Date(Date.UTC(2024, 0, 15, h));

  it("sorts and coalesces overlapping and touching intervals without mutating the input", () => {
    const input = [
      { start: at(13), end: at(14) },
      { start: at(9), end: at(11) },
      { start: at(10), end: at(10) },
      { start: at(11), end: at(12) },
    ];
    expect(mergeIntervals(input)).toEqual([{ start: at(9), end: at(12) }, { start: at(13), end: at(14) }]);
    expect(input[1]).toEqual({ start: at(9), end: at(11) });
  });
});

describe("busyChecker", () => {
  const at = (h: number, m = 0) => new Date(Date.UTC(2024, 0, 15, h, m));
  const slot = (h: number, m: number, minutes: number) => ({ start: at(h, m), end: addMinutes(at(h, m), minutes) });

  it("checks slots in order against busy time from several calendars", () => {
    const isBusy = busyChecker([
      { start: at(12), end: at(13) },
      { start: at(10), end: at(11) },
      { start: at(10, 30), end: at(11, 30) },
    ]);
    expect([
      isBusy(slot(9, 0, 60)),
      isBusy(slot(9, 30, 60)),
      isBusy(slot(11, 0, 30)),
      isBusy(slot(11, 30, 30)),
      isBusy(slot(11, 30, 60)),
      isBusy(slot(13, 0, 60)),
    ]).toEqual([false, true, true, false, true, false]);
  });

  it("flags a slot that contains a whole busy interval", () => {
    expect(busyChecker([{ start: at(10), end: at(11) }])(slot(9, 0, 180))).toBe(true);
  });
});
