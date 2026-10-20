import { z } from "zod";
import { eventsPath } from "../google/client.js";
import { attachmentInputSchema, attachmentsDescription, normalizeAttachments } from "../lib/attachments.js";
import { attendeeInputSchema, normalizeAttendees } from "../lib/attendees.js";
import { buildEventOptions, eventOptionsInputSchema, eventTypeInputSchema, validateEventTypeTimes, withEventTypeHint } from "../lib/event-options.js";
import { eventSchema, toStructuredEvent } from "../lib/event-model.js";
import { renderMarkdown } from "../lib/markdown.js";
import { assertOrdered, inZone, lacksNamedZone, parseRange, rangeTimes } from "../lib/schedule.js";
import { WRITE_SCOPE, defineTool } from "./define.js";
import { calendarIdSchema, inputTimeZoneSchema, sendUpdatesSchema } from "./schemas.js";

export const createEvent = defineTool({
  name: "create_event",
  description:
    "Create a new calendar event (meeting, appointment, or all-day block). " +
    "Pass `start` and `end` as ISO 8601 strings: use a date-only form ('YYYY-MM-DD') for an ALL-DAY event (end is EXCLUSIVE: use the day after the last day), or a datetime ('YYYY-MM-DDTHH:MM[:SS]' with optional 'Z'/'±HH:MM' offset) for a TIMED event. " +
    "Both `start` and `end` must be the same kind, and `end` must be after `start`. Naive datetimes are interpreted in `timeZone`; a local time skipped by a daylight-saving change is moved one hour later. " +
    "`description` is rendered through Markdown to HTML by the server. " +
    "When `attendees` are provided, Google sends invitations according to `sendUpdates` (default 'all'). " +
    "Optional extras: `recurrence` (RRULE strings) for a repeating series, `addGoogleMeet` for a Meet link, `colorId`, `visibility`, `availability` (busy/free), `reminders`, `guestPermissions` and Drive `attachments`. " +
    "Special kinds via `eventType`: outOfOffice (with `outOfOffice` decline settings), focusTime (`focusTime`), workingLocation (`workingLocation`); these are only accepted on the primary calendar. " +
    "Returns the created event including `id` which is required for update_event / delete_event.",
  scope: WRITE_SCOPE,
  outputSchema: eventSchema.shape,
  schema: {
    calendarId: calendarIdSchema('Calendar ID. Defaults to "primary". Use list_calendars to discover other calendar IDs.'),
    summary: z.string().describe("Event title (required)."),
    description: z.string().optional().describe("Event description. Rendered as Markdown to HTML by the server."),
    location: z.string().optional().describe("Event location (address, meeting room, etc.)."),
    start: z
      .string()
      .describe('Start as ISO 8601. Date-only ("2024-01-15") creates an all-day event. Datetime ("2024-01-15T14:00:00" or "2024-01-15T14:00:00-08:00") creates a timed event. Naive datetimes are interpreted in `timeZone`.'),
    end: z
      .string()
      .describe("End as ISO 8601, same kind as `start`. For all-day, end date is EXCLUSIVE (use the next day for a single-day event). For timed, must be after `start`."),
    timeZone: inputTimeZoneSchema,
    attendees: z.array(attendeeInputSchema).optional().describe('Attendees to invite. Each item may be a bare email string ("alice@example.com") or an object {email, displayName?, optional?}. Set optional=true to mark an attendee as non-essential.'),
    sendUpdates: sendUpdatesSchema("Invitation behaviour. all: notify everyone, externalOnly: only non-Google-Calendar users, none: no notifications."),
    attachments: z.array(attachmentInputSchema).optional().describe(attachmentsDescription),
    ...eventOptionsInputSchema,
    ...eventTypeInputSchema,
  },
  async run(p, client) {
    const range = parseRange(p.start, p.end);
    const options = buildEventOptions(p);
    const attachments = p.attachments && normalizeAttachments(p.attachments);
    const attendees = p.attendees && p.attendees.length > 0 ? normalizeAttendees(p.attendees) : undefined;

    const zone = client.zone(p.calendarId, p.timeZone);
    const rangeAsGiven = await rangeTimes(range, zone);
    const times = options.recurrence?.length && lacksNamedZone(rangeAsGiven) ? inZone(rangeAsGiven, await zone()) : rangeAsGiven;
    validateEventTypeTimes(options.eventType, times);
    assertOrdered(times);

    const body = {
      summary: p.summary,
      description: p.description ? renderMarkdown(p.description) : undefined,
      location: p.location,
      ...options,
      ...(attachments && { attachments }),
      ...times,
      ...(attendees && { attendees }),
    };
    try {
      const created = await client.event(eventsPath(p.calendarId), {
        method: "POST",
        query: {
          sendUpdates: p.sendUpdates,
          conferenceDataVersion: body.conferenceData ? "1" : undefined,
          supportsAttachments: attachments ? "true" : undefined,
        },
        body,
      }, { operation: "create calendar event", resource: "calendar", resourceId: p.calendarId });
      return toStructuredEvent(created);
    } catch (err) {
      throw withEventTypeHint(err, options.eventType);
    }
  },
});
