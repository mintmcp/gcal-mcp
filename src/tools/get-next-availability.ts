import { z } from "zod";
import { HMS_RE, advanceToNextSlot, alignToSlotBoundary, isSlotBusy, isWithinSearchHours } from "../lib/availability.js";
import { getDayOfWeek, parseBound, toInstant, toLocalISO, type FormattedDateTime } from "../lib/datetime.js";
import { formattedDateTimeSchema, type FreeBusyResponse } from "../lib/event-model.js";
import { fail } from "../lib/failure.js";
import { READ_SCOPE, defineTool } from "./define.js";
import { calendarIdSchema, timeZoneSchema } from "./schemas.js";

function formatSlotTime(date: Date, timeZone: string): FormattedDateTime {
  const local = toLocalISO(date, timeZone);
  const [day, time] = local.split("T");
  return { date: day, time, dayOfWeek: getDayOfWeek(local) };
}

function freeBusyFailure(id: string, reason: string | undefined): string {
  if (reason === "notFound") return `Calendar "${id}" not found. Verify via list_calendars.`;
  if (reason === "forbidden") return `Access denied for calendar "${id}". The authenticated user cannot read its free/busy info.`;
  return `Free/busy lookup failed for calendar "${id}": ${reason || "unknown error"}.`;
}

export const getNextAvailability = defineTool({
  name: "get_next_availability",
  description:
    "Find the next time slots that are free on EVERY listed calendar by scanning Google's free/busy data. " +
    "Pass `calendarIds` (email addresses of the people to meet, or calendar IDs) to find a slot that works for several people; `calendarId` (default primary) is always included. " +
    "Pass `startFrom` as ISO 8601 (date-only, naive datetime, or with offset). Defaults to NOW. " +
    "`duration` is the desired meeting length in minutes. " +
    "Restrict to a daily window via `searchHoursStart`/`searchHoursEnd` (HH:MM[:SS] in `timezone`). " +
    "Restrict to specific weekdays via `includeDays` (default: Mon-Fri). " +
    "Slots align to `startTimeIncrement` (default 30 min) boundaries. " +
    "Returns up to `maxResults` slots (default 10) and a boolean `exhausted` flag: when `exhausted` is true, the full search window was scanned and no more slots exist; when false, paginate by calling again with `startFrom = searchedUntil`. " +
    "CAVEAT: free/busy reflects ONLY the listed calendars; meetings on other calendars the user attends are NOT considered. Surface this to the user before confirming a slot.",
  scope: READ_SCOPE,
  readOnlyHint: true,
  outputSchema: {
    calendarId: z.string(),
    calendarIds: z.array(z.string()),
    availableSlots: z.array(z.object({
      start: formattedDateTimeSchema,
      end: formattedDateTimeSchema,
    })),
    searchedUntil: z.string(),
    exhausted: z.boolean(),
  },
  schema: {
    calendarId: calendarIdSchema('Calendar ID. Defaults to "primary".'),
    calendarIds: z
      .array(z.string())
      .max(49)
      .optional()
      .describe('Additional calendars (max 49) that must ALSO be free, e.g. attendee email addresses ["alice@example.com"]. Their free/busy must be visible to the user.'),
    duration: z.coerce.number().int().positive().describe("Meeting length in minutes (e.g., 30, 60, 90). Required."),
    timezone: timeZoneSchema('IANA timezone (e.g., "America/New_York", "UTC"). Used for `searchHoursStart`/`searchHoursEnd` and to format response times. Defaults to the time zone of `calendarId`.'),
    startFrom: z
      .string()
      .optional()
      .describe('Start searching from this ISO 8601 instant. Date-only ("YYYY-MM-DD") starts at 00:00:00 in `timezone`. Datetime forms work too. Defaults to NOW.'),
    searchHoursStart: z
      .string()
      .regex(HMS_RE, "searchHoursStart must be HH:MM or HH:MM:SS in 24-hour format")
      .optional()
      .describe('Daily window start as HH:MM[:SS] in `timezone` (e.g. "09:00"). If omitted, all hours are considered.'),
    searchHoursEnd: z
      .string()
      .regex(HMS_RE, "searchHoursEnd must be HH:MM or HH:MM:SS in 24-hour format")
      .optional()
      .describe('Daily window end as HH:MM[:SS] in `timezone` (e.g. "17:00"). If omitted, all hours are considered.'),
    includeDays: z
      .array(z.enum(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]))
      .optional()
      .default(["Mon", "Tue", "Wed", "Thu", "Fri"])
      .describe("Weekdays to include. Default: weekdays only."),
    startTimeIncrement: z.coerce.number().int().positive().optional().default(30).describe("Minutes between candidate start times (e.g. 15, 30). Default 30."),
    maxResults: z.coerce.number().int().positive().optional().default(10).describe("Maximum slots to return. Default 10."),
    maxSearchDays: z.coerce.number().int().positive().max(365).optional().default(30).describe("Maximum days ahead of `startFrom` to scan. Default 30, hard cap 365."),
  },
  async run(p, client) {
    const allCalendarIds = [...new Set([p.calendarId, ...(p.calendarIds ?? [])])];
    const startFrom = p.startFrom === undefined ? undefined : parseBound("startFrom", p.startFrom);
    const timezone = p.timezone ?? (await client.calendar(p.calendarId)).timeZone;
    const searchStart = startFrom ? new Date(toInstant(startFrom, timezone)) : new Date();
    const searchEnd = new Date(searchStart);
    searchEnd.setDate(searchEnd.getDate() + p.maxSearchDays);

    const operation = "query free/busy for calendar";
    const data = await client.call<FreeBusyResponse>("/freeBusy", {
      method: "POST",
      body: {
        timeMin: searchStart.toISOString(),
        timeMax: searchEnd.toISOString(),
        timeZone: timezone,
        items: allCalendarIds.map((id) => ({ id })),
      },
    }, { operation, resource: "calendar", resourceId: p.calendarId });

    const busyTimes: Array<{ start: Date; end: Date }> = [];
    for (const id of allCalendarIds) {
      const calendar = data?.calendars?.[id];
      if (!calendar) {
        fail(`Calendar ID "${id}" not present in free/busy response. Verify the ID via list_calendars.`, { operation, resource: "calendar", resourceId: id });
      }
      const reason = calendar.errors?.[0]?.reason;
      if (calendar.errors?.length) {
        fail(freeBusyFailure(id, reason), { operation, resource: "calendar", resourceId: id, googleReason: reason });
      }
      for (const busy of calendar.busy ?? []) busyTimes.push({ start: new Date(busy.start), end: new Date(busy.end) });
    }
    busyTimes.sort((a, b) => a.start.getTime() - b.start.getTime());

    const window = { timeZone: timezone, includeDays: p.includeDays, searchHoursStart: p.searchHoursStart, searchHoursEnd: p.searchHoursEnd };
    const availableSlots: Array<{ start: FormattedDateTime; end: FormattedDateTime }> = [];
    let currentTime = new Date(searchStart);
    while (availableSlots.length < p.maxResults && currentTime < searchEnd) {
      currentTime = alignToSlotBoundary(currentTime, p.startTimeIncrement);
      const slotStart = new Date(currentTime);
      const slotEnd = new Date(slotStart);
      slotEnd.setMinutes(slotEnd.getMinutes() + p.duration);
      if (
        isWithinSearchHours(slotStart, { ...window, boundary: "start" })
        && isWithinSearchHours(slotEnd, { ...window, boundary: "end" })
        && !isSlotBusy(slotStart, slotEnd, busyTimes)
      ) {
        availableSlots.push({ start: formatSlotTime(slotStart, timezone), end: formatSlotTime(slotEnd, timezone) });
      }
      currentTime = advanceToNextSlot(currentTime, p.startTimeIncrement);
    }

    const searchedUntil = currentTime > searchEnd ? searchEnd : currentTime;
    return {
      calendarId: p.calendarId,
      calendarIds: allCalendarIds,
      availableSlots,
      searchedUntil: toLocalISO(searchedUntil, timezone),
      exhausted: availableSlots.length < p.maxResults,
    };
  },
});
