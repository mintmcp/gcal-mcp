export const HMS_RE = /^([01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;

export interface LocalClock {
  weekday: string;
  minute: number;
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
    const minute = Number(parts.minute);
    return { weekday: parts.weekday, minute, seconds: Number(parts.hour) * 3600 + minute * 60 + Number(parts.second) };
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

export function alignToSlotBoundary(date: Date, incrementMinutes: number, clock: (date: Date) => LocalClock): Date {
  const remainder = clock(date).minute % incrementMinutes;
  const out = addMinutes(date, remainder === 0 ? 0 : incrementMinutes - remainder);
  out.setUTCSeconds(0, 0);
  return out;
}

export function isSlotBusy(slotStart: Date, slotEnd: Date, busyTimes: Array<{ start: Date; end: Date }>): boolean {
  return busyTimes.some((busy) => slotStart < busy.end && slotEnd > busy.start);
}
