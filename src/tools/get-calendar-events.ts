import { z } from "zod";
import { eventsPath, type CalendarClient } from "../google/client.js";
import { parseBound, resolveInstant } from "../lib/datetime.js";
import { eventSchema, toStructuredEvent, type EventsListResponse } from "../lib/event-model.js";
import { fail } from "../lib/failure.js";
import { decodePageToken, encodePageToken, queryFingerprint } from "../lib/page-token.js";
import { EVENT_TYPES } from "../lib/event-options.js";
import { defineTool } from "./define.js";
import { calendarIdSchema, timeZoneSchema } from "./schemas.js";

async function resolveBounds(
  client: CalendarClient,
  { calendarId, timeMin, timeMax, timeZone }: { calendarId: string; timeMin?: string; timeMax?: string; timeZone?: string },
): Promise<{ timeMin: string; timeMax?: string }> {
  const zone = client.zone(calendarId, timeZone);
  const min = timeMin === undefined ? new Date().toISOString() : await resolveInstant(parseBound("timeMin", timeMin), zone);
  const max = timeMax === undefined ? undefined : await resolveInstant(parseBound("timeMax", timeMax), zone);
  if (max && Date.parse(max) <= Date.parse(min)) {
    fail(`\`timeMax\` must be after \`timeMin\`${timeMin === undefined ? " (which defaults to NOW; pass an earlier `timeMin` for past events)" : ""}.`, { timeMin: min, timeMax: max });
  }
  return { timeMin: min, ...(max && { timeMax: max }) };
}

export const getCalendarEvents = defineTool({
  name: "get_calendar_events",
  description:
    "List events from a Google Calendar within a time range. Use this to read what's on a user's calendar (meetings, appointments, all-day events) for any date or range. " +
    "Defaults to the user's primary calendar starting NOW; call list_calendars first only when you need a non-primary calendar's ID. " +
    "Time inputs accept full ISO 8601 strings: 'YYYY-MM-DD' (treated as start of that day in `timeZone`), naive 'YYYY-MM-DDTHH:MM[:SS]' (combined with `timeZone`), or zone-aware '...Z' / '...±HH:MM'. " +
    "Without `timeMax`, returns the next `maxResults` events from `timeMin` onwards. " +
    "For a single calendar day, set `timeMin='2024-01-15'` and `timeMax='2024-01-16'` (end is EXCLUSIVE). " +
    "Pass `q` to search by keyword (matches title, description, location, attendee names/emails); like any listing it starts at `timeMin` (default NOW) and runs oldest first, so pass an earlier `timeMin` only when the user asks about past events. " +
    "Response times are formatted in `timeZone` when given, otherwise in the calendar's own time zone. " +
    "If `nextPageToken` is returned, more events match: pass it back as `pageToken` together with the SAME calendarId, `q`, filters and time bounds to continue (the token remembers the resolved bounds, including a defaulted NOW, so later pages do not drift; a token reused with a different query is rejected). " +
    "Recurring events are returned as expanded instances; each `id` (which may contain a date suffix) targets that single occurrence in update_event/delete_event. Set `expandRecurring=false` to get series masters instead. " +
    "Filter by `eventTypes` (default, outOfOffice, focusTime, workingLocation, birthday, fromGmail); without it Google returns every type. `orderBy` is startTime (default) or updated; `showDeleted` includes cancelled events. " +
    "Event `id`s in the response are required for update_event / delete_event.",
  readOnlyHint: true,
  outputSchema: {
    calendarId: z.string(),
    events: z.array(eventSchema),
    nextPageToken: z.string().nullable(),
    message: z.string().optional(),
  },
  schema: {
    calendarId: calendarIdSchema('Calendar ID. Defaults to "primary" (the user\'s main calendar). Use list_calendars to discover other calendar IDs.'),
    maxResults: z.coerce.number().int().min(1).max(2500).optional().default(10).describe("Number of events to return (1-2500). Default: 10. Google may return slightly fewer; check `nextPageToken`."),
    timeMin: z
      .string()
      .optional()
      .describe('Lower time bound (inclusive) as ISO 8601: "YYYY-MM-DD", "YYYY-MM-DDTHH:MM[:SS]", or "...Z"/"...±HH:MM". Defaults to NOW. Naive forms are interpreted in `timeZone`.'),
    timeMax: z
      .string()
      .optional()
      .describe("Upper time bound (EXCLUSIVE) as ISO 8601, same formats as `timeMin`. Omit to retrieve future events from `timeMin`."),
    timeZone: timeZoneSchema('IANA timezone (e.g. "America/Los_Angeles") used to interpret naive/date-only inputs and to format response times. Defaults to the calendar\'s own time zone.'),
    q: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Free-text search. Case-insensitive; matches title, description, location and attendee names/emails. Searches from `timeMin` (default NOW); pass an earlier `timeMin` to include past events."),
    pageToken: z.string().optional().describe("Pagination token from a prior call's `nextPageToken`. Pass it back to fetch the next page."),
    eventTypes: z
      .array(z.enum(EVENT_TYPES))
      .min(1)
      .optional()
      .describe('Only return these event types, e.g. ["outOfOffice"] or ["workingLocation"]. Omit for every type.'),
    orderBy: z
      .enum(["startTime", "updated"])
      .optional()
      .describe("startTime (default, ascending; requires expandRecurring=true) or updated (last modification, ascending)."),
    showDeleted: z.boolean().optional().describe('true: include cancelled/deleted events (status "cancelled").'),
    expandRecurring: z
      .boolean()
      .optional()
      .default(true)
      .describe("true (default): recurring events appear as individual instances. false: each series appears once as its master (with `recurrence`); ordering by startTime is then unavailable."),
  },
  async run(p, client) {
    if (p.orderBy === "startTime" && !p.expandRecurring) {
      fail("Google can only order by startTime when recurring events are expanded. Use orderBy='updated' or expandRecurring=true.");
    }
    const filters = {
      singleEvents: String(p.expandRecurring),
      orderBy: p.orderBy ?? (p.expandRecurring ? "startTime" : undefined),
      ...(p.showDeleted && { showDeleted: "true" }),
      eventTypes: p.eventTypes,
      q: p.q,
    };
    const query = queryFingerprint({ calendarId: p.calendarId, ...filters, timeMin: p.timeMin, timeMax: p.timeMax });
    const cursor = p.pageToken === undefined ? undefined : decodePageToken(p.pageToken, query);
    const bounds = cursor ?? await resolveBounds(client, p);

    const data = await client.call<EventsListResponse>(eventsPath(p.calendarId), {
      query: {
        ...filters,
        maxResults: String(p.maxResults),
        pageToken: cursor?.googleToken,
        timeZone: p.timeZone,
        timeMin: bounds.timeMin,
        timeMax: bounds.timeMax,
      },
    }, { operation: "fetch calendar events", resource: "calendar", resourceId: p.calendarId });

    const nextPageToken = data?.nextPageToken
      ? encodePageToken({ googleToken: data.nextPageToken, timeMin: bounds.timeMin, timeMax: bounds.timeMax, query })
      : null;
    const items = data?.items ?? [];
    if (items.length === 0) {
      return {
        calendarId: p.calendarId,
        events: [],
        nextPageToken,
        message: nextPageToken
          ? "No events on this page, but more may match. Pass `nextPageToken` back as `pageToken` to continue."
          : `No events found in calendar "${p.calendarId}" for the requested range`,
      };
    }
    return { calendarId: p.calendarId, events: items.map(toStructuredEvent), nextPageToken };
  },
});
