// Pure datetime / attendee helpers used by the Google Calendar tools.
// Extracted from src/tools.ts so they can be unit-tested without spinning up
// the MCP transport or stubbing fetch. NOTHING here should perform I/O —
// helpers operate only on their arguments.

export type ParsedIso =
  | { kind: "date"; date: string } // YYYY-MM-DD
  | { kind: "datetime"; rfc3339: string; hasOffset: boolean };

export interface FormattedDateTime {
  date: string;
  time?: string;
  dayOfWeek: string;
  timezone?: string;
}

// ISO 8601 patterns:
//   - Date-only:        YYYY-MM-DD
//   - Naive datetime:   YYYY-MM-DDTHH:MM[:SS][.fff]
//   - Aware datetime:   YYYY-MM-DDTHH:MM[:SS][.fff](Z|±HH:MM)
const ISO_DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME_AWARE_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const ISO_DATETIME_NAIVE_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?$/;

/**
 * Parse a user-supplied ISO 8601 string into a normalised form.
 * - "2024-01-15" → { kind: "date" }
 * - "2024-01-15T09:00:00Z" or with offset → { kind: "datetime", hasOffset: true }
 * - "2024-01-15T09:00:00" (naive) → { kind: "datetime", hasOffset: false }
 * Returns null on invalid input.
 */
export function parseIso(input: string): ParsedIso | null {
  if (typeof input !== "string") return null;
  const s = input.trim();
  if (ISO_DATE_ONLY_RE.test(s)) {
    const d = new Date(`${s}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return null;
    return { kind: "date", date: s };
  }
  if (ISO_DATETIME_AWARE_RE.test(s)) {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return null;
    return { kind: "datetime", rfc3339: s, hasOffset: true };
  }
  if (ISO_DATETIME_NAIVE_RE.test(s)) {
    return { kind: "datetime", rfc3339: s, hasOffset: false };
  }
  return null;
}

/**
 * Return the wall-clock offset of `timeZone` at `atInstant` formatted as
 * "+HH:MM" / "-HH:MM", or "Z" for UTC. `atInstant` defaults to "now".
 *
 * Uses `Intl.DateTimeFormat` with `timeZoneName: "longOffset"`, which yields
 * strings like "GMT-08:00"; we strip the "GMT" prefix. For UTC the formatter
 * yields just "GMT", which we normalise to "Z" to match the convention used
 * by `attachOffsetForTimezone`.
 */
export function getOffset(timeZone: string, atInstant?: Date): string {
  if (timeZone === "UTC") return "Z";
  const probe = atInstant ?? new Date();
  if (Number.isNaN(probe.getTime())) return "Z";
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
  });
  const offsetPart =
    formatter.formatToParts(probe).find((p) => p.type === "timeZoneName")?.value || "";
  const offset = offsetPart.replace("GMT", "").trim();
  return offset || "Z";
}

/**
 * Given a naive ISO datetime ("YYYY-MM-DDTHH:MM[:SS]") and an IANA timezone,
 * return an RFC3339 string with the correct offset for that wall-clock time.
 */
export function attachOffsetForTimezone(naiveIso: string, timeZone: string): string {
  const probe = new Date(naiveIso);
  if (Number.isNaN(probe.getTime())) {
    throw new Error(`attachOffsetForTimezone: cannot parse naive ISO "${naiveIso}"`);
  }
  if (timeZone === "UTC") return `${naiveIso}Z`;
  const offset = getOffset(timeZone, probe);
  return `${naiveIso}${offset}`;
}

/**
 * Day-of-week label ("Sun".."Sat") for the wall-clock date portion of an ISO
 * datetime or date-only string. Anchors at UTC noon to dodge DST/edge issues
 * so the day reported is whichever day the event appears on in the calendar.
 */
export function getDayOfWeek(dateStr: string): string {
  const tIdx = dateStr.indexOf("T");
  const datePart = tIdx >= 0 ? dateStr.slice(0, tIdx) : dateStr;
  const date = new Date(`${datePart}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return "";
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return days[date.getUTCDay()];
}

/**
 * Format a Google Calendar `event.start`/`event.end` shape into a
 * `FormattedDateTime`. Preserves the wall-clock date/time from the original
 * zone-aware ISO string so we don't accidentally shift the day by reading
 * the UTC components.
 */
export function formatDateTimeWithDay(eventDateTime: {
  dateTime?: string;
  date?: string;
} | undefined | null): FormattedDateTime {
  // A single-event fetch can return an event with no start/end (e.g. a
  // cancelled recurring instance carries only id/status), so tolerate nullish.
  if (!eventDateTime) {
    return { date: "", dayOfWeek: "" };
  }
  if (eventDateTime.dateTime) {
    const raw = eventDateTime.dateTime;
    const tIdx = raw.indexOf("T");
    const datePart = tIdx >= 0 ? raw.slice(0, tIdx) : raw;
    const timePart = tIdx >= 0 ? raw.slice(tIdx + 1) : "";

    let time = "";
    let timezone = "";
    if (timePart) {
      if (timePart.endsWith("Z")) {
        time = timePart.slice(0, -1);
        timezone = "Z";
      } else {
        const offsetMatch = timePart.match(/([+-]\d{2}:\d{2})$/);
        if (offsetMatch) {
          timezone = offsetMatch[1];
          time = timePart.slice(0, -timezone.length);
        } else {
          time = timePart;
        }
      }
    }

    return {
      date: datePart,
      time,
      dayOfWeek: getDayOfWeek(raw),
      timezone,
    };
  } else if (eventDateTime.date) {
    return {
      date: eventDateTime.date,
      dayOfWeek: getDayOfWeek(eventDateTime.date),
    };
  }

  return {
    date: "",
    dayOfWeek: "",
  };
}

/**
 * Normalise a heterogeneous attendee input array (bare emails or
 * `{ email, displayName?, optional? }` objects) into the shape Google
 * Calendar expects. Drops empty `displayName`s and only sets `optional`
 * when explicitly true.
 */
export function normalizeAttendees(
  input:
    | Array<string | { email: string; displayName?: string; optional?: boolean }>
    | undefined,
): Array<{ email: string; displayName?: string; optional?: boolean }> | undefined {
  if (!input) return undefined;
  return input.map((a) => {
    if (typeof a === "string") return { email: a };
    const out: { email: string; displayName?: string; optional?: boolean } = {
      email: a.email,
    };
    if (typeof a.displayName === "string" && a.displayName.length > 0) {
      out.displayName = a.displayName;
    }
    if (a.optional === true) out.optional = true;
    return out;
  });
}

// ---------- get_next_availability slot helpers ----------

export interface SearchHoursOpts {
  timeZone: string;
  includeDays?: string[];
  searchHoursStart?: string;
  searchHoursEnd?: string;
  boundary: "start" | "end";
}

/**
 * Is `date` within the configured search window (weekday filter + daily
 * hour window)?
 *
 * - The weekday filter is always applied when `includeDays` is non-empty,
 *   regardless of whether an hour window is set.
 * - `boundary='start'` means strict upper bound (a slot starting exactly at
 *   `searchHoursEnd` is rejected). `boundary='end'` means inclusive upper
 *   bound (a slot ending exactly at `searchHoursEnd` is allowed).
 */
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
  const hour = parseInt(parts.find((p) => p.type === "hour")?.value || "0", 10);
  const minute = parseInt(parts.find((p) => p.type === "minute")?.value || "0", 10);
  const second = parseInt(parts.find((p) => p.type === "second")?.value || "0", 10);
  const weekday = parts.find((p) => p.type === "weekday")?.value;

  if (opts.includeDays && weekday && !opts.includeDays.includes(weekday)) {
    return false;
  }

  if (!opts.searchHoursStart && !opts.searchHoursEnd) return true;

  const currentTimeInSeconds = hour * 3600 + minute * 60 + second;

  const parseHms = (s: string): number => {
    if (!/^([01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(s)) {
      throw new Error(`parseHms: expected HH:MM[:SS] in 24-hour format, got "${s}"`);
    }
    const [h, m, sec = 0] = s.split(":").map((v) => Number(v));
    return h * 3600 + m * 60 + sec;
  };

  let startSeconds = 0;
  let endSeconds = 24 * 3600;
  if (opts.searchHoursStart) startSeconds = parseHms(opts.searchHoursStart);
  if (opts.searchHoursEnd) endSeconds = parseHms(opts.searchHoursEnd);

  if (currentTimeInSeconds < startSeconds) return false;
  return opts.boundary === "end"
    ? currentTimeInSeconds <= endSeconds
    : currentTimeInSeconds < endSeconds;
}

/**
 * Round `date` up to the next multiple of `incrementMinutes` past the hour,
 * always zeroing seconds and milliseconds. Returns a new Date; does not
 * mutate the input.
 *
 * Note: zeroing seconds/ms is unconditional so that a non-aligned-by-seconds
 * input (e.g. 10:30:17.123 on a 30-min grid) snaps to 10:30:00, not stays
 * off-grid. Slot iteration in `get_next_availability` relies on this to
 * report slots whose times match the requested increment exactly.
 */
export function alignToSlotBoundary(date: Date, incrementMinutes: number): Date {
  if (!Number.isInteger(incrementMinutes) || incrementMinutes <= 0) {
    throw new Error(`alignToSlotBoundary: incrementMinutes must be a positive integer, got ${incrementMinutes}`);
  }
  const out = new Date(date);
  const minutes = out.getMinutes();
  const remainder = minutes % incrementMinutes;
  if (remainder !== 0) {
    out.setMinutes(minutes + (incrementMinutes - remainder));
  }
  out.setSeconds(0);
  out.setMilliseconds(0);
  return out;
}

/** Add `incrementMinutes` to `date`, returning a new Date. */
export function advanceToNextSlot(date: Date, incrementMinutes: number): Date {
  const next = new Date(date);
  next.setMinutes(next.getMinutes() + incrementMinutes);
  return next;
}

/**
 * Does `[slotStart, slotEnd)` overlap any of the busy periods?
 * Equal endpoints (touching) do NOT count as overlap.
 */
export function isSlotBusy(
  slotStart: Date,
  slotEnd: Date,
  busyTimes: Array<{ start: Date; end: Date }>,
): boolean {
  for (const busy of busyTimes) {
    if (slotStart < busy.end && slotEnd > busy.start) {
      return true;
    }
  }
  return false;
}

/**
 * Format `date` as a naive ISO 8601 string ("YYYY-MM-DDTHH:MM:SS") in `tz`,
 * without a timezone suffix.
 */
export function toLocalISO(date: Date, tz: string): string {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const getValue = (type: string) => parts.find((p) => p.type === type)?.value || "00";
  return `${getValue("year")}-${getValue("month")}-${getValue("day")}T${getValue("hour")}:${getValue("minute")}:${getValue("second")}`;
}
