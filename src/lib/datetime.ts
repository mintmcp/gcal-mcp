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

export function parseIso(input: string): ParsedIso | null {
  if (typeof input !== "string") return null;
  const s = input.trim();
  if (ISO_DATE_ONLY_RE.test(s)) {
    return Number.isNaN(Date.parse(`${s}T00:00:00Z`)) ? null : { kind: "date", date: s };
  }
  const naive = s.replace(OFFSET_RE, "");
  if (!ISO_DATETIME_NAIVE_RE.test(naive)) return null;
  const offset = naive !== s;
  if (Number.isNaN(Date.parse(offset ? s : `${s}Z`))) return null;
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
  return offsetPart.replace("GMT", "").trim() || "Z";
}

export function attachOffsetForTimezone(naiveIso: string, timeZone: string): string {
  if (Number.isNaN(new Date(naiveIso).getTime())) {
    throw new Error(`attachOffsetForTimezone: cannot parse naive ISO "${naiveIso}"`);
  }
  if (timeZone === "UTC") return `${naiveIso}Z`;
  const nearby = getOffset(timeZone, new Date(`${naiveIso}Z`));
  const offset = getOffset(timeZone, new Date(`${naiveIso}${nearby}`));
  if (offset === nearby || wallClockMatches(naiveIso, offset, timeZone)) return `${naiveIso}${offset}`;
  // Google Calendar moves a local time inside a spring-forward gap one hour later
  const preTransition = offsetMinutes(offset) < offsetMinutes(nearby) ? offset : nearby;
  return `${naiveIso}${preTransition}`;
}

function offsetMinutes(offset: string): number {
  if (offset === "Z") return 0;
  const sign = offset.startsWith("-") ? -1 : 1;
  const [h, m] = offset.slice(1).split(":").map(Number);
  return sign * (h * 60 + m);
}

function wallClockMatches(naiveIso: string, offset: string, timeZone: string): boolean {
  const local = toLocalISO(new Date(`${naiveIso}${offset}`), timeZone);
  return local.startsWith(naiveIso.slice(0, 19));
}

export function localTimeExists(naiveIso: string, timeZone: string): boolean {
  return wallClockMatches(naiveIso, attachOffsetForTimezone(naiveIso, timeZone).slice(naiveIso.length), timeZone);
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
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
