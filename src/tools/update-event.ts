import { z } from "zod";
import { eventPath, type CalendarClient } from "../google/client.js";
import { attachmentInputSchema, mergeAttachments, normalizeAttachments } from "../lib/attachments.js";
import { attendeeInputSchema, emailSchema, mergeAttendees, normalizeAttendees } from "../lib/attendees.js";
import { assertEventTypeOptions, buildEventOptions, eventOptionsInputSchema, validateEventTypeTimes, withEventTypeHint } from "../lib/event-options.js";
import { eventSchema, toStructuredEvent, type CalendarEvent, type EventAttachment } from "../lib/event-model.js";
import { fail } from "../lib/failure.js";
import { renderMarkdown } from "../lib/markdown.js";
import {
  assertOrdered,
  endOnlyTimes,
  lacksNamedZone,
  parseReschedule,
  rangeTimes,
  relabel,
  shiftedTimes,
  storedTimes,
  toPatchTime,
  type Reschedule,
  type TimePair,
  type Zone,
} from "../lib/schedule.js";
import { WRITE_SCOPE, defineTool } from "./define.js";
import { calendarIdSchema, inputTimeZoneSchema, sendUpdatesSchema } from "./schemas.js";

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

type ZoneLabels = { start?: string; end?: string };

function changedTimes(reschedule: Reschedule, current: CalendarEvent, inputZone: Zone, endZone: Zone): Promise<TimePair> {
  switch (reschedule.kind) {
    case "range":
      return rangeTimes(reschedule.range, inputZone);
    case "start":
      return shiftedTimes(current, reschedule.start, inputZone, endZone);
    case "end":
      return endOnlyTimes(current, reschedule.end, inputZone);
  }
}

async function zoneLabels(p: UpdateArgs, reschedule: Reschedule | undefined, current: CalendarEvent, recurring: boolean, client: CalendarClient): Promise<ZoneLabels> {
  if (recurring) {
    const zone = p.timeZone ?? current.start?.timeZone ?? await client.zone(p.calendarId)();
    return { start: zone, end: zone };
  }
  return {
    start: reschedule?.kind === "end" ? current.start?.timeZone : p.timeZone ?? current.start?.timeZone,
    end: p.timeZone ?? current.end?.timeZone,
  };
}

async function schedulePatch(p: UpdateArgs, reschedule: Reschedule | undefined, current: CalendarEvent, client: CalendarClient) {
  const stored = storedTimes(current);
  const recurring = p.recurrence !== undefined ? p.recurrence.length > 0 : (current.recurrence?.length ?? 0) > 0;
  if (!reschedule && !(recurring && stored && lacksNamedZone(stored))) return {};
  const timed = reschedule?.kind === "range" ? reschedule.range.kind === "datetime" : current.start?.dateTime !== undefined;
  const labels = timed ? await zoneLabels(p, reschedule, current, recurring, client) : {};
  const inputZone = client.zone(p.calendarId, p.timeZone);
  const times = reschedule ? await changedTimes(reschedule, current, inputZone, async () => labels.end ?? await inputZone()) : stored;
  if (!times) return {};
  validateEventTypeTimes(current.eventType, times);
  assertOrdered(times);
  return { start: toPatchTime(relabel(times.start, labels.start)), end: toPatchTime(relabel(times.end, labels.end)) };
}

async function loadCurrent(client: CalendarClient, calendarId: string, eventId: string): Promise<CalendarEvent> {
  const current = await client.getEvent(calendarId, eventId, "load event before updating");
  if (current.status === "cancelled") {
    fail(`Event "${eventId}" was cancelled and no longer exists, so it cannot be updated. If it is an occurrence of a recurring series, list the series instances again (get_calendar_events) and use a current occurrence id.`, {
      resource: "event",
      resourceId: eventId,
    });
  }
  return current;
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
    "Naive datetimes are read in `timeZone`, else the calendar's own time zone. Each endpoint keeps the time zone it already has unless `timeZone` is passed; a recurring series keeps one shared time zone. " +
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
      || [p.addAttendees, p.removeAttendees, p.addAttachments, p.removeAttachments, p.availability, p.visibility].some((v) => v !== undefined);
    const current = needsCurrent ? await loadCurrent(client, p.calendarId, p.eventId) : undefined;
    if (current) assertEventTypeOptions(current.eventType, p);

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
