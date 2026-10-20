import { z } from "zod";
import { eventPath, type CalendarClient } from "../google/client.js";
import {
  buildEventOptions,
  mergeAttachments,
  mergeAttendees,
  normalizeAttachments,
  normalizeAttendees,
  validateEventTypeTimes,
  withEventTypeHint,
} from "../lib/event-fields.js";
import { eventSchema, toStructuredEvent, type CalendarEvent, type EventAttachment } from "../lib/event-model.js";
import { fail } from "../lib/failure.js";
import { renderMarkdown } from "../lib/markdown.js";
import {
  assertOrdered,
  endOnlyTime,
  inZone,
  lacksNamedZone,
  parseReschedule,
  rangeTimes,
  shiftedTimes,
  storedTime,
  toPatchTime,
  type Reschedule,
  type TimePair,
} from "../lib/schedule.js";
import { WRITE_SCOPE, defineTool } from "./define.js";
import {
  attachmentInputSchema,
  attendeeInputSchema,
  calendarIdSchema,
  emailSchema,
  eventOptionsInputSchema,
  inputTimeZoneSchema,
  sendUpdatesSchema,
} from "./schemas.js";

const schema = {
  calendarId: calendarIdSchema('Calendar containing the event. Defaults to "primary".'),
  eventId: z.string().describe("Event ID (from get_calendar_events or create_event)."),
  summary: z.string().optional().describe("New event title."),
  description: z.string().optional().describe("New description. Rendered as Markdown to HTML server-side. Pass an empty string to clear."),
  location: z.string().optional().describe("New location. Pass an empty string to clear."),
  start: z
    .string()
    .optional()
    .describe("New start as ISO 8601: date-only for all-day, datetime for timed. Alone, moves the event keeping its current duration. Omit to leave the start unchanged."),
  end: z
    .string()
    .optional()
    .describe("New end as ISO 8601. Alone, changes only the end (must stay after the start). With `start`, both must be the same kind."),
  timeZone: inputTimeZoneSchema,
  attendees: z
    .array(attendeeInputSchema)
    .optional()
    .describe("REPLACES the entire attendee list with the given items (each a bare email or {email, displayName?, optional?}). Include existing attendees you want to keep. Pass [] to remove all. Prefer addAttendees / removeAttendees for incremental changes."),
  addAttendees: z
    .array(attendeeInputSchema)
    .optional()
    .describe("Attendees to ADD (bare email or {email, displayName?, optional?}). Existing attendees and their responses are kept. Cannot be combined with `attendees`."),
  removeAttendees: z
    .array(emailSchema)
    .optional()
    .describe("Email addresses of attendees to REMOVE (each must be a current attendee, matched case-insensitively). Everyone else keeps their response. Cannot be combined with `attendees`."),
  sendUpdates: sendUpdatesSchema("Notification behaviour. all / externalOnly / none."),
  attachments: z.array(attachmentInputSchema).optional().describe("REPLACES the attachment list (at most 25). Pass [] to remove every attachment. Prefer addAttachments / removeAttachments for incremental changes."),
  addAttachments: z.array(attachmentInputSchema).optional().describe("Drive files to attach, keeping the existing ones. Cannot be combined with `attachments`."),
  removeAttachments: z.array(z.string().trim().min(1)).optional().describe("Attachments to drop, each a Drive file id or the stored fileUrl of a current attachment. Cannot be combined with `attachments`."),
  ...eventOptionsInputSchema,
};

type UpdateArgs = z.infer<z.ZodObject<typeof schema>>;

function assertExclusive(p: UpdateArgs, replace: keyof UpdateArgs, ...incremental: Array<keyof UpdateArgs>): void {
  if (p[replace] !== undefined && incremental.some((key) => p[key] !== undefined)) {
    fail(`Pass either \`${replace}\` (full replacement) or ${incremental.map((k) => `\`${k}\``).join(" / ")} (incremental), not both.`);
  }
}

async function changedTimes(p: UpdateArgs, reschedule: Reschedule | undefined, current: CalendarEvent, client: CalendarClient): Promise<Partial<TimePair>> {
  const preferredZone = p.timeZone ?? current.start?.timeZone;
  switch (reschedule?.kind) {
    case "range":
      return rangeTimes(reschedule.range, client.zone(p.calendarId, p.timeZone));
    case "start":
      return shiftedTimes(current, reschedule.start, client.zone(p.calendarId, preferredZone));
    case "end":
      return { end: await endOnlyTime(current, reschedule.end, preferredZone, client.zone(p.calendarId)) };
    default:
      return {};
  }
}

async function schedulePatch(p: UpdateArgs, reschedule: Reschedule | undefined, current: CalendarEvent, client: CalendarClient) {
  const changed = await changedTimes(p, reschedule, current, client);
  const start = changed.start ?? storedTime(current.start);
  const end = changed.end ?? storedTime(current.end);
  if (!start || !end) return {};
  const recurring = p.recurrence !== undefined ? p.recurrence.length > 0 : (current.recurrence?.length ?? 0) > 0;
  const rezoned = recurring && lacksNamedZone({ start, end })
    ? inZone({ start, end }, p.timeZone ?? current.start?.timeZone ?? await client.calendarTimeZone(p.calendarId))
    : undefined;
  if (reschedule) {
    const times = rezoned ?? { start, end };
    validateEventTypeTimes(current.eventType, times);
    assertOrdered(times);
  }
  const patch = rezoned ?? changed;
  return {
    ...(patch.start && { start: toPatchTime(patch.start) }),
    ...(patch.end && { end: toPatchTime(patch.end) }),
  };
}

function attendeePatch(p: UpdateArgs, current: CalendarEvent) {
  if (p.addAttendees === undefined && p.removeAttendees === undefined) return {};
  if (current.attendeesOmitted === true) {
    fail(`Google truncated the guest list for event "${current.summary || current.id}", so changing attendees here would drop the ones it left out. Edit the guest list in Google Calendar directly.`, {
      resource: "event",
      resourceId: current.id,
    });
  }
  return { attendees: mergeAttendees(current.attendees, normalizeAttendees(p.addAttendees ?? []), p.removeAttendees ?? []) };
}

function attachmentPatch(p: UpdateArgs, added: EventAttachment[], current: CalendarEvent) {
  if (p.addAttachments === undefined && p.removeAttachments === undefined) return {};
  return { attachments: mergeAttachments(current.attachments, added, p.removeAttachments ?? []) };
}

export const updateEvent = defineTool({
  name: "update_event",
  description:
    "Patch fields on an existing Google Calendar event by `eventId`. " +
    "Omit a field to leave it unchanged. Pass an empty string for `location` (or empty array for `attendees`) to CLEAR that field. " +
    "To reschedule, pass `start` and/or `end` as ISO 8601: date-only for all-day, datetime for timed. With only `start`, the event moves and keeps its duration; with only `end`, just the end changes. Pass neither to leave the schedule unchanged; pass both to change the kind (timed <-> all-day). The resulting `end` must be after `start`. " +
    "`description` is rendered through Markdown to HTML by the server. " +
    "To add or remove guests, use `addAttendees` / `removeAttendees`: everyone else keeps their current response; removing someone who is not a guest is an error. " +
    "ATTENDEES WARNING: `attendees` REPLACES the entire attendee list and resets every responseStatus to needsAction; whether notifications are re-sent depends on `sendUpdates`. To accept/decline/tentatively respond for YOURSELF, use respond_to_event instead: it preserves everyone else's responses. " +
    "Optional extras: `recurrence`, `addGoogleMeet`, `colorId`, `visibility`, `availability` (busy/free), `reminders` and `guestPermissions`. " +
    "Drive attachments: `addAttachments` / `removeAttachments` edit the list incrementally; `attachments` REPLACES it (pass [] to remove all). " +
    "Cannot move an event between calendars or change its `eventType`. For a recurring-instance `eventId` (date-suffixed), the patch applies to that single occurrence only. Returns the updated event including a fresh `updated` timestamp.",
  scope: WRITE_SCOPE,
  destructiveHint: true,
  outputSchema: eventSchema.shape,
  schema,
  async run(p, client) {
    assertExclusive(p, "attendees", "addAttendees", "removeAttendees");
    assertExclusive(p, "attachments", "addAttachments", "removeAttachments");
    const reschedule = parseReschedule(p.start, p.end);
    const options = buildEventOptions(p);
    const replacedAttachments = p.attachments && normalizeAttachments(p.attachments);
    const addedAttachments = normalizeAttachments(p.addAttachments ?? []);

    const needsCurrent = reschedule !== undefined
      || (p.recurrence?.length ?? 0) > 0
      || [p.addAttendees, p.removeAttendees, p.addAttachments, p.removeAttachments].some((v) => v !== undefined);
    const current = needsCurrent ? await client.getEvent(p.calendarId, p.eventId, "load event before updating") : undefined;

    const patch = {
      ...options,
      ...(p.summary !== undefined && { summary: p.summary }),
      ...(p.description !== undefined && { description: renderMarkdown(p.description) }),
      ...(p.location !== undefined && { location: p.location }),
      ...(p.attendees !== undefined && { attendees: normalizeAttendees(p.attendees) }),
      ...(replacedAttachments && { attachments: replacedAttachments }),
      ...(current && {
        ...await schedulePatch(p, reschedule, current, client),
        ...attendeePatch(p, current),
        ...attachmentPatch(p, addedAttachments, current),
      }),
    };

    try {
      const updated = await client.event(eventPath(p.calendarId, p.eventId), {
        method: "PATCH",
        query: {
          sendUpdates: p.sendUpdates,
          conferenceDataVersion: patch.conferenceData ? "1" : undefined,
          supportsAttachments: patch.attachments ? "true" : undefined,
        },
        body: patch,
        ifMatch: current?.etag,
      }, { operation: "update calendar event", resource: "event", resourceId: p.eventId });
      return toStructuredEvent(updated);
    } catch (err) {
      throw withEventTypeHint(err, current?.eventType);
    }
  },
});
