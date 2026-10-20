import { z } from "zod";
import { eventSchema, toStructuredEvent } from "../lib/event-model.js";
import { defineTool } from "./define.js";
import { calendarIdSchema, timeZoneSchema } from "./schemas.js";

export const getEvent = defineTool({
  name: "get_event",
  description:
    "Fetch a SINGLE Google Calendar event by its `eventId`. Use this when you already have an event's ID (from get_calendar_events, create_event, or a Google Calendar link) and want its full, current details. " +
    "Prefer this over get_calendar_events when you know the exact event: it is a direct lookup, not a time-range scan. " +
    "Defaults to the user's primary calendar; pass `calendarId` (from list_calendars) for a non-primary calendar. " +
    "For a recurring event, pass the series `eventId` to read the series master, or a single instance ID ('<eventId>_<UTC timestamp>', e.g. 'abc123_20240115T170000Z') to read that one occurrence. " +
    "Returns the event {id, summary, start, end, location, description, attendees, ...}. Its `id` is the same value required by update_event / delete_event. " +
    "Recurring events are distinguishable: a SERIES MASTER carries `recurrence` (RRULE strings describing the repeat pattern); a single INSTANCE carries `recurringEventId` (the series `id`, to navigate back to the master) and `originalStartTime` (its scheduled slot; if it differs from `start`, the occurrence was moved).",
  readOnlyHint: true,
  outputSchema: {
    calendarId: z.string(),
    event: eventSchema,
  },
  schema: {
    calendarId: calendarIdSchema('Calendar containing the event. Defaults to "primary". Use list_calendars to discover other calendar IDs.'),
    eventId: z.string().describe("Event ID to fetch (from get_calendar_events, create_event, or a calendar link)."),
    timeZone: timeZoneSchema('IANA timezone (e.g. "America/Los_Angeles") used to format the returned event times. Defaults to the calendar\'s own time zone.'),
  },
  async run({ calendarId, eventId, timeZone }, client) {
    const event = await client.getEvent(calendarId, eventId, "fetch calendar event", timeZone);
    return { calendarId, event: toStructuredEvent(event) };
  },
});
