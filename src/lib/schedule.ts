import { attachOffsetForTimezone, hasOffset, localInstant, parseBound, toLocalISO, toZonedIso, type ParsedIso } from "./datetime.js";
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

export function lacksSharedZone({ start, end }: TimePair): boolean {
  return "dateTime" in start && "dateTime" in end && !(start.timeZone && start.timeZone === end.timeZone);
}

export function inZone({ start, end }: TimePair, timeZone: string): TimePair {
  return { start: relabel(start, timeZone), end: relabel(end, timeZone) };
}

// Google expands a recurring timed event in one named time zone shared by both endpoints
export async function seriesTimes(times: TimePair, recurring: boolean, zone: Zone): Promise<TimePair> {
  return recurring && lacksSharedZone(times) ? inZone(times, await zone()) : times;
}

function instantMs(time: EventTime): number {
  if ("date" in time) return Date.parse(`${time.date}T00:00:00Z`);
  if (hasOffset(time.dateTime) || !time.timeZone) return Date.parse(time.dateTime);
  return Date.parse(attachOffsetForTimezone(time.dateTime, time.timeZone));
}

function skippedLocalTime(time: EventTime): string | undefined {
  if ("date" in time || hasOffset(time.dateTime) || !time.timeZone) return undefined;
  return localInstant(time.dateTime, time.timeZone) ? undefined : `${time.dateTime} does not exist in ${time.timeZone}`;
}

// Google keeps a timed endpoint as wall clock plus zone and reads a repeated wall time as its first occurrence
function repeatedLocalTime(time: EventTime): string | undefined {
  if ("date" in time || !time.timeZone || !hasOffset(time.dateTime)) return undefined;
  const instant = new Date(time.dateTime);
  const wall = toLocalISO(instant, time.timeZone);
  const resolved = Date.parse(attachOffsetForTimezone(wall, time.timeZone));
  return resolved === instant.getTime() - instant.getMilliseconds() ? undefined : `${time.dateTime} (${wall} in ${time.timeZone})`;
}

export function assertOrdered({ start, end }: TimePair): void {
  const repeated = [start, end].map(repeatedLocalTime).filter(Boolean);
  if (repeated.length > 0) {
    fail(`${repeated.join(" and ")} falls in the second pass of an hour that clocks repeat when daylight saving time ends, and Google Calendar always reads that local time as its first pass. Pick a time outside the repeated hour.`);
  }
  if (instantMs(end) > instantMs(start)) return;
  const skipped = [start, end].map(skippedLocalTime).filter(Boolean);
  if (skipped.length > 0) {
    fail(`${skipped.join(" and ")}: clocks skip that hour for daylight saving time, so the event would not end after it starts. Pick a local time outside the skipped hour.`);
  }
  fail("`end` must be after `start`.", { start, end });
}

function storedTime(time: EventDateTime | undefined): EventTime | undefined {
  if (time?.dateTime) return { dateTime: time.dateTime, ...(time.timeZone && { timeZone: time.timeZone }) };
  if (time?.date) return { date: time.date };
  return undefined;
}

export function storedTimes(event: CalendarEvent): TimePair | undefined {
  const start = storedTime(event.start);
  const end = storedTime(event.end);
  return start && end ? { start, end } : undefined;
}

function requireStored(event: CalendarEvent): TimePair {
  return storedTimes(event) ?? fail("The event has no stored start/end to reschedule from; pass both `start` and `end`.");
}

function assertSameKind(current: CalendarEvent, bound: ParsedIso, name: "start" | "end"): void {
  if (bound.kind === "date" && !current.start?.date) {
    fail(`This is a timed event; pass a datetime \`${name}\`, or pass both \`start\` and \`end\` as dates to make it all-day.`);
  }
  if (bound.kind === "datetime" && !current.start?.dateTime) {
    fail(`This is an all-day event; pass a date-only \`${name}\`, or pass both \`start\` and \`end\` as datetimes to make it timed.`);
  }
}

async function pinnedTime(bound: ParsedIso, zone: Zone): Promise<EventTime> {
  if (bound.kind === "date") return { date: bound.date };
  return bound.hasOffset ? { dateTime: bound.rfc3339 } : { dateTime: bound.rfc3339, timeZone: await zone() };
}

export async function shiftedTimes(current: CalendarEvent, start: ParsedIso, inputZone: Zone, endZone: Zone): Promise<TimePair> {
  const stored = requireStored(current);
  const durationMs = instantMs(stored.end) - instantMs(stored.start);
  assertSameKind(current, start, "start");
  const newStart = await pinnedTime(start, inputZone);
  const endMs = instantMs(newStart) + durationMs;
  if ("date" in newStart) return { start: newStart, end: { date: new Date(endMs).toISOString().slice(0, 10) } };
  const timeZone = await endZone();
  return { start: newStart, end: { dateTime: toZonedIso(new Date(endMs), timeZone), timeZone } };
}

export async function endOnlyTimes(current: CalendarEvent, end: ParsedIso, inputZone: Zone): Promise<TimePair> {
  const stored = requireStored(current);
  assertSameKind(current, end, "end");
  return { start: stored.start, end: await pinnedTime(end, inputZone) };
}

export function relabel(time: EventTime, label: string | undefined): EventTime {
  if ("date" in time || !label || time.timeZone === label) return time;
  const dateTime = hasOffset(time.dateTime) || !time.timeZone ? time.dateTime : attachOffsetForTimezone(time.dateTime, time.timeZone);
  return { dateTime, timeZone: label };
}

// PATCH merges start/end objects, so a kind switch must null the other kind's fields
export function toPatchTime(time: EventTime) {
  return "date" in time
    ? { date: time.date, dateTime: null, timeZone: null }
    : { ...time, date: null };
}
