import { localInstant, toLocalISO } from "./datetime.js";

const DAY_SECONDS = 24 * 3600;

export const HMS_RE = /^([01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;

export interface LocalClock {
  date: string;
  seconds: number;
}

export interface SearchWindow {
  days: readonly string[];
  startSeconds: number;
  endSeconds: number;
}

export function hmsToSeconds(hms: string): number {
  const [h, m, s = 0] = hms.split(":").map(Number);
  return h * 3600 + m * 60 + s;
}

export function localClock(timeZone: string): (date: Date) => LocalClock {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  return (date) => {
    const parts = Object.fromEntries(formatter.formatToParts(date).map((p) => [p.type, p.value]));
    return {
      date: `${parts.year}-${parts.month}-${parts.day}`,
      seconds: Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second),
    };
  };
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function weekdayOf(date: string): string {
  return WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()];
}

export function isFullDay(window: SearchWindow): boolean {
  return window.startSeconds === 0 && window.endSeconds === DAY_SECONDS;
}

export function fitsWindow(slot: Interval, clock: (date: Date) => LocalClock, window: SearchWindow): boolean {
  const start = clock(slot.start);
  const end = clock(slot.end);
  const endsAtMidnight = end.seconds === 0 && end.date > start.date;
  const lastDate = endsAtMidnight ? previousDay(end.date) : end.date;
  const endSeconds = endsAtMidnight ? DAY_SECONDS : end.seconds;
  if (lastDate !== start.date) {
    if (!isFullDay(window)) return false;
    for (let date = start.date; date <= lastDate; date = nextDay(date)) {
      if (!window.days.includes(weekdayOf(date))) return false;
    }
    return true;
  }
  // A slot crosses at most one clock change, so its local clock never leaves these bounds even inside a fall-back fold
  const elapsed = (slot.end.getTime() - slot.start.getTime()) / 1000;
  return window.days.includes(weekdayOf(start.date))
    && Math.min(start.seconds, endSeconds - elapsed) >= window.startSeconds
    && Math.max(start.seconds + elapsed, endSeconds) <= window.endSeconds;
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

function hms(seconds: number): string {
  return [seconds / 3600, (seconds % 3600) / 60, seconds % 60].map((n) => String(Math.floor(n)).padStart(2, "0")).join(":");
}

function shiftDay(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_SECONDS * 1000).toISOString().slice(0, 10);
}

function nextDay(date: string): string {
  return shiftDay(date, 1);
}

function previousDay(date: string): string {
  return shiftDay(date, -1);
}

export function* slotStarts(from: Date, incrementMinutes: number, timeZone: string): Generator<Date, never> {
  const step = incrementMinutes * 60;
  const [firstDay, firstTime] = toLocalISO(from, timeZone).split("T");
  let day = firstDay;
  let seconds = Math.ceil(hmsToSeconds(firstTime) / step) * step;
  for (;;) {
    for (; seconds < DAY_SECONDS; seconds += step) {
      const instant = localInstant(`${day}T${hms(seconds)}`, timeZone);
      const start = instant && new Date(instant);
      if (start && start >= from) yield start;
    }
    day = nextDay(day);
    seconds = 0;
  }
}

export interface Interval {
  start: Date;
  end: Date;
}

export function mergeIntervals(intervals: Interval[]): Interval[] {
  const merged: Interval[] = [];
  for (const next of [...intervals].sort((a, b) => a.start.getTime() - b.start.getTime())) {
    const last = merged.at(-1);
    if (last && next.start <= last.end) last.end = next.end > last.end ? next.end : last.end;
    else merged.push({ ...next });
  }
  return merged;
}

// Expects slots in increasing start order, so the cursor only moves forward
export function busyChecker(busy: Interval[]): (slot: Interval) => boolean {
  const merged = mergeIntervals(busy);
  let i = 0;
  return ({ start, end }) => {
    while (i < merged.length && merged[i].end <= start) i++;
    return i < merged.length && merged[i].start < end;
  };
}
