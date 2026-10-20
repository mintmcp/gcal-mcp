export const HMS_RE = /^([01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;

export interface SearchHoursOpts {
  timeZone: string;
  includeDays?: string[];
  searchHoursStart?: string;
  searchHoursEnd?: string;
  boundary: "start" | "end";
}

function parseHms(s: string): number {
  if (!HMS_RE.test(s)) throw new Error(`parseHms: expected HH:MM[:SS] in 24-hour format, got "${s}"`);
  const [h, m, sec = 0] = s.split(":").map(Number);
  return h * 3600 + m * 60 + sec;
}

export function isWithinSearchHours(date: Date, opts: SearchHoursOpts): boolean {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: opts.timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    weekday: "short",
  });
  const parts = formatter.formatToParts(date);
  const part = (type: string) => parts.find((p) => p.type === type)?.value;
  const weekday = part("weekday");
  if (opts.includeDays && weekday && !opts.includeDays.includes(weekday)) return false;
  if (!opts.searchHoursStart && !opts.searchHoursEnd) return true;

  const seconds = Number(part("hour") ?? 0) * 3600 + Number(part("minute") ?? 0) * 60 + Number(part("second") ?? 0);
  const startSeconds = opts.searchHoursStart ? parseHms(opts.searchHoursStart) : 0;
  const endSeconds = opts.searchHoursEnd ? parseHms(opts.searchHoursEnd) : 24 * 3600;
  if (seconds < startSeconds) return false;
  return opts.boundary === "end" ? seconds <= endSeconds : seconds < endSeconds;
}

export function alignToSlotBoundary(date: Date, incrementMinutes: number): Date {
  if (!Number.isInteger(incrementMinutes) || incrementMinutes <= 0) {
    throw new Error(`alignToSlotBoundary: incrementMinutes must be a positive integer, got ${incrementMinutes}`);
  }
  const out = new Date(date);
  const remainder = out.getMinutes() % incrementMinutes;
  if (remainder !== 0) out.setMinutes(out.getMinutes() + (incrementMinutes - remainder));
  out.setSeconds(0, 0);
  return out;
}

export function advanceToNextSlot(date: Date, incrementMinutes: number): Date {
  const next = new Date(date);
  next.setMinutes(next.getMinutes() + incrementMinutes);
  return next;
}

export function isSlotBusy(slotStart: Date, slotEnd: Date, busyTimes: Array<{ start: Date; end: Date }>): boolean {
  return busyTimes.some((busy) => slotStart < busy.end && slotEnd > busy.start);
}
