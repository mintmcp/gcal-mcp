import { attachOffsetForTimezone, localTimeExists, toLocalISO } from "./datetime.js";

export const HMS_RE = /^([01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;

export interface LocalClock {
  weekday: string;
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
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  return (date) => {
    const parts = Object.fromEntries(formatter.formatToParts(date).map((p) => [p.type, p.value]));
    return { weekday: parts.weekday, seconds: Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second) };
  };
}

export function fitsWindow(start: LocalClock, end: LocalClock, window: SearchWindow): boolean {
  return window.days.includes(start.weekday)
    && window.days.includes(end.weekday)
    && start.seconds >= window.startSeconds
    && start.seconds < window.endSeconds
    && end.seconds >= window.startSeconds
    && end.seconds <= window.endSeconds;
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

const DAY_SECONDS = 24 * 3600;

function hms(seconds: number): string {
  return [seconds / 3600, (seconds % 3600) / 60, seconds % 60].map((n) => String(Math.floor(n)).padStart(2, "0")).join(":");
}

function nextDay(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + DAY_SECONDS * 1000).toISOString().slice(0, 10);
}

export function* slotStarts(from: Date, incrementMinutes: number, timeZone: string): Generator<Date, never> {
  const step = incrementMinutes * 60;
  const [firstDay, firstTime] = toLocalISO(from, timeZone).split("T");
  let day = firstDay;
  let seconds = Math.ceil(hmsToSeconds(firstTime) / step) * step;
  for (;;) {
    for (; seconds < DAY_SECONDS; seconds += step) {
      const local = `${day}T${hms(seconds)}`;
      if (!localTimeExists(local, timeZone)) continue;
      const start = new Date(attachOffsetForTimezone(local, timeZone));
      if (start >= from) yield start;
    }
    day = nextDay(day);
    seconds = 0;
  }
}

export function isSlotBusy(slotStart: Date, slotEnd: Date, busyTimes: Array<{ start: Date; end: Date }>): boolean {
  return busyTimes.some((busy) => slotStart < busy.end && slotEnd > busy.start);
}
