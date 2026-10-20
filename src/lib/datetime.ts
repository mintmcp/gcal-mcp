import { fail } from "./failure.js";

export type ParsedIso =
  | { kind: "date"; date: string }
  | { kind: "datetime"; rfc3339: string; hasOffset: boolean };

export type FormattedDateTime = {
  date: string;
  time?: string;
  dayOfWeek: string;
  timezone?: string;
};

const ISO_DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME_NAIVE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?$/;
const OFFSET_RE = /(?:Z|[+-]\d{2}:\d{2})$/;

const FORMATS = {
  offset: { timeZoneName: "longOffset" },
  local: { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false },
} satisfies Record<string, Intl.DateTimeFormatOptions>;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string, format: keyof typeof FORMATS): Intl.DateTimeFormat {
  const key = `${format} ${timeZone}`;
  const cached = formatters.get(key) ?? new Intl.DateTimeFormat("en-US", { ...FORMATS[format], timeZone });
  formatters.set(key, cached);
  return cached;
}

export function hasOffset(dateTime: string): boolean {
  return OFFSET_RE.test(dateTime);
}

// Date.parse rolls impossible values over (Feb 29 in a common year becomes Mar 1, 24:00 the next day)
function isRealCalendarTime(naive: string): boolean {
  const ms = Date.parse(naive.length === 10 ? `${naive}T00:00:00Z` : `${naive}Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().startsWith(naive.slice(0, 19));
}

export function parseIso(input: string): ParsedIso | null {
  if (typeof input !== "string") return null;
  const s = input.trim();
  if (ISO_DATE_ONLY_RE.test(s)) {
    return isRealCalendarTime(s) ? { kind: "date", date: s } : null;
  }
  const naive = s.replace(OFFSET_RE, "");
  if (!ISO_DATETIME_NAIVE_RE.test(naive) || !isRealCalendarTime(naive)) return null;
  const offset = naive !== s;
  if (offset && Number.isNaN(Date.parse(s))) return null;
  return { kind: "datetime", rfc3339: s, hasOffset: offset };
}

export function parseBound(name: string, value: string): ParsedIso {
  return parseIso(value) ?? fail(`Invalid \`${name}\` "${value}". Expected ISO 8601: YYYY-MM-DD, YYYY-MM-DDTHH:MM[:SS], or with Z/offset.`);
}

export function getOffset(timeZone: string, atInstant?: Date): string {
  if (timeZone === "UTC") return "Z";
  const probe = atInstant ?? new Date();
  if (Number.isNaN(probe.getTime())) return "Z";
  const offsetPart = formatter(timeZone, "offset").formatToParts(probe).find((p) => p.type === "timeZoneName")?.value || "";
  // Historic local mean time offsets carry seconds (-04:56:02), which RFC 3339 cannot express
  return offsetPart.replace("GMT", "").trim().replace(/^([+-]\d{2}:\d{2}):\d{2}$/, "$1") || "Z";
}

const DAY_MS = 24 * 3600 * 1000;

function offsetAround(naiveIso: string, timeZone: string, deltaMs: number): string {
  return getOffset(timeZone, new Date(Date.parse(`${naiveIso}Z`) + deltaMs));
}

// Tries the offset before a nearby transition first, so a repeated wall time resolves to its earlier instant
export function localInstant(naiveIso: string, timeZone: string): string | undefined {
  const offsets = new Set([offsetAround(naiveIso, timeZone, -DAY_MS), offsetAround(naiveIso, timeZone, DAY_MS)]);
  return [...offsets]
    .map((offset) => `${naiveIso}${offset}`)
    .find((iso) => toLocalISO(new Date(iso), timeZone).startsWith(naiveIso.slice(0, 19)));
}

export function attachOffsetForTimezone(naiveIso: string, timeZone: string): string {
  if (Number.isNaN(new Date(naiveIso).getTime())) {
    throw new Error(`attachOffsetForTimezone: cannot parse naive ISO "${naiveIso}"`);
  }
  if (timeZone === "UTC") return `${naiveIso}Z`;
  // Google Calendar moves a local time inside a spring-forward gap one hour later
  return localInstant(naiveIso, timeZone) ?? `${naiveIso}${offsetAround(naiveIso, timeZone, -DAY_MS)}`;
}

export function toZonedIso(date: Date, timeZone: string): string {
  return `${toLocalISO(date, timeZone)}${getOffset(timeZone, date)}`;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function canonicalTimeZone(timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions().timeZone;
}

export function toInstant(parsed: ParsedIso, timeZone: string): string {
  if (parsed.kind === "date") return attachOffsetForTimezone(`${parsed.date}T00:00:00`, timeZone);
  return parsed.hasOffset ? parsed.rfc3339 : attachOffsetForTimezone(parsed.rfc3339, timeZone);
}

export async function resolveInstant(parsed: ParsedIso, zone: () => Promise<string>): Promise<string> {
  if (parsed.kind === "datetime" && parsed.hasOffset) return parsed.rfc3339;
  return toInstant(parsed, await zone());
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function getDayOfWeek(dateStr: string): string {
  const date = new Date(`${dateStr.split("T")[0]}T12:00:00Z`);
  return Number.isNaN(date.getTime()) ? "" : WEEKDAYS[date.getUTCDay()];
}

export function formatDateTimeWithDay(eventDateTime: { dateTime?: string; date?: string } | undefined | null): FormattedDateTime {
  if (eventDateTime?.dateTime) {
    const raw = eventDateTime.dateTime;
    const [datePart, timePart = ""] = raw.split("T");
    const timezone = timePart.match(OFFSET_RE)?.[0] ?? "";
    return {
      date: datePart,
      time: timePart.slice(0, timePart.length - timezone.length),
      dayOfWeek: getDayOfWeek(raw),
      timezone,
    };
  }
  if (eventDateTime?.date) return { date: eventDateTime.date, dayOfWeek: getDayOfWeek(eventDateTime.date) };
  return { date: "", dayOfWeek: "" };
}

export function toLocalISO(date: Date, tz: string): string {
  const parts = formatter(tz, "local").formatToParts(date);
  const getValue = (type: string) => parts.find((p) => p.type === type)?.value || "00";
  return `${getValue("year")}-${getValue("month")}-${getValue("day")}T${getValue("hour")}:${getValue("minute")}:${getValue("second")}`;
}
