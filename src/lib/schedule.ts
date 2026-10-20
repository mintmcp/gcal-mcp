import { attachOffsetForTimezone, localTimeExists, parseIso, toInstant, toLocalISO, type ParsedIso } from "./datetime.js";
import { fail } from "./failure.js";
import type { CalendarEvent, EventDateTime } from "./event-model.js";

type DateIso = Extract<ParsedIso, { kind: "date" }>;
type DateTimeIso = Extract<ParsedIso, { kind: "datetime" }>;

export type ParsedRange =
  | { kind: "date"; start: DateIso; end: DateIso }
  | { kind: "datetime"; start: DateTimeIso; end: DateTimeIso };

export type EventTime = { date: string } | { dateTime: string; timeZone?: string };
export type TimePair = { start: EventTime; end: EventTime };
export type Zone = () => Promise<string>;

export type Reschedule =
  | { kind: "range"; range: ParsedRange }
  | { kind: "start"; start: ParsedIso }
  | { kind: "end"; end: ParsedIso };

export function parseBound(name: string, value: string): ParsedIso {
  return parseIso(value) ?? fail(`Invalid \`${name}\` "${value}". Expected ISO 8601: YYYY-MM-DD, YYYY-MM-DDTHH:MM[:SS], or with Z/offset.`);
}

export function parseRange(start: string, end: string): ParsedRange {
  const s = parseBound("start", start);
  const e = parseBound("end", end);
  if (s.kind === "date" && e.kind === "date") return { kind: "date", start: s, end: e };
  if (s.kind === "datetime" && e.kind === "datetime") return { kind: "datetime", start: s, end: e };
  fail("`start` and `end` must be the same kind (both date-only for all-day, or both datetime for timed).");
}

export function parseReschedule(start: string | undefined, end: string | undefined): Reschedule | undefined {
  if (start !== undefined && end !== undefined) return { kind: "range", range: parseRange(start, end) };
  if (start !== undefined) return { kind: "start", start: parseBound("start", start) };
  if (end !== undefined) return { kind: "end", end: parseBound("end", end) };
  return undefined;
}

export async function rangeTimes(range: ParsedRange, zone: Zone): Promise<TimePair> {
  if (range.kind === "date") return { start: { date: range.start.date }, end: { date: range.end.date } };
  const timeZone = range.start.hasOffset && range.end.hasOffset ? undefined : await zone();
  return {
    start: { dateTime: range.start.rfc3339, ...(timeZone && { timeZone }) },
    end: { dateTime: range.end.rfc3339, ...(timeZone && { timeZone }) },
  };
}

// Google requires a named time zone on recurring timed events; an offset alone is rejected
export function lacksNamedZone({ start, end }: TimePair): boolean {
  return "dateTime" in start && "dateTime" in end && !(start.timeZone && end.timeZone);
}

export function inZone({ start, end }: TimePair, timeZone: string): TimePair {
  return { start: { ...start, timeZone }, end: { ...end, timeZone } };
}

const hasOffset = (dateTime: string) => /(?:Z|[+-]\d{2}:\d{2})$/.test(dateTime);

function instantMs(time: EventTime): number {
  if ("date" in time) return Date.parse(`${time.date}T00:00:00Z`);
  if (hasOffset(time.dateTime) || !time.timeZone) return Date.parse(time.dateTime);
  return Date.parse(attachOffsetForTimezone(time.dateTime, time.timeZone));
}

function skippedLocalTime(time: EventTime): string | undefined {
  if ("date" in time || hasOffset(time.dateTime) || !time.timeZone) return undefined;
  return localTimeExists(time.dateTime, time.timeZone) ? undefined : `${time.dateTime} does not exist in ${time.timeZone}`;
}

export function assertOrdered({ start, end }: TimePair): void {
  if (instantMs(end) > instantMs(start)) return;
  const skipped = [start, end].map(skippedLocalTime).filter(Boolean);
  if (skipped.length > 0) {
    fail(`${skipped.join(" and ")}: clocks skip that hour for daylight saving time, so the event would not end after it starts. Pick a local time outside the skipped hour.`);
  }
  fail("`end` must be after `start`.", { start, end });
}

export function storedTime(time: EventDateTime | undefined): EventTime | undefined {
  if (time?.dateTime) return { dateTime: time.dateTime, ...(time.timeZone && { timeZone: time.timeZone }) };
  if (time?.date) return { date: time.date };
  return undefined;
}

function storedDurationMs(event: CalendarEvent): number {
  const start = storedTime(event.start);
  const end = storedTime(event.end);
  const ms = start && end && "date" in start === "date" in end ? instantMs(end) - instantMs(start) : NaN;
  return Number.isFinite(ms) ? ms : fail("The event has no stored start/end to derive a duration from; pass both `start` and `end`.");
}

function assertSameKind(current: CalendarEvent, bound: ParsedIso, name: "start" | "end"): void {
  if (bound.kind === "date" && !current.start?.date) {
    fail(`This is a timed event; pass a datetime \`${name}\`, or pass both \`start\` and \`end\` as dates to make it all-day.`);
  }
  if (bound.kind === "datetime" && !current.start?.dateTime) {
    fail(`This is an all-day event; pass a date-only \`${name}\`, or pass both \`start\` and \`end\` as datetimes to make it timed.`);
  }
}

export async function shiftedTimes(current: CalendarEvent, start: ParsedIso, eventZone: Zone): Promise<TimePair> {
  const durationMs = storedDurationMs(current);
  assertSameKind(current, start, "start");
  if (start.kind === "date") {
    const endDate = new Date(Date.parse(`${start.date}T00:00:00Z`) + durationMs).toISOString().slice(0, 10);
    return { start: { date: start.date }, end: { date: endDate } };
  }
  const timeZone = await eventZone();
  const endLocal = toLocalISO(new Date(Date.parse(toInstant(start, timeZone)) + durationMs), timeZone);
  return { start: { dateTime: start.rfc3339, timeZone }, end: { dateTime: endLocal, timeZone } };
}

export async function endOnlyTime(current: CalendarEvent, end: ParsedIso, preferredZone: string | undefined, calendarZone: Zone): Promise<EventTime> {
  assertSameKind(current, end, "end");
  if (end.kind === "date") return { date: end.date };
  const timeZone = preferredZone ?? (end.hasOffset ? undefined : await calendarZone());
  return { dateTime: end.rfc3339, ...(timeZone && { timeZone }) };
}

// PATCH merges start/end objects, so a kind switch must null the other kind's fields
export function toPatchTime(time: EventTime) {
  return "date" in time
    ? { date: time.date, dateTime: null, timeZone: null }
    : { ...time, date: null };
}
