import { z } from "zod";
import { eventPath, type CalendarClient } from "../google/client.js";
import { attachmentInputSchema, mergeAttachments, normalizeAttachments } from "../lib/attachments.js";
import { attendeeInputSchema, emailSchema, mergeAttendees, normalizeAttendees } from "../lib/attendees.js";
import { assertEventTypeOptions, buildEventOptions, eventOptionsInputSchema, validateEventTypeTimes } from "../lib/event-options.js";
import { eventSchema, type CalendarEvent, type EventAttachment } from "../lib/event-model.js";
import { fail } from "../lib/failure.js";
import { renderMarkdown } from "../lib/markdown.js";
import {
  assertSchedulable,
  endOnlyTimes,
  inZone,
  parseReschedule,
  rangeTimes,
  relabel,
  seriesTimes,
  shiftedTimes,
  storedTimes,
  toPatchTime,
  type Reschedule,
  type TimePair,
  type Zone,
} from "../lib/schedule.js";
import { defineTool } from "./define.js";
import { calendarIdSchema, inputTimeZoneSchema, sendUpdatesSchema } from "./schemas.js";
import { writeEvent } from "./write-event.js";

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

function isRecurring(p: UpdateArgs, current: CalendarEvent): boolean {
  return (p.recurrence ?? current.recurrence ?? []).length > 0;
}

function seriesZone(p: UpdateArgs, current: CalendarEvent, client: CalendarClient): Promise<string> {
  return client.zone(p.calendarId, p.timeZone ?? current.start?.timeZone)();
}

async function zoneLabels(p: UpdateArgs, reschedule: Reschedule, current: CalendarEvent, client: CalendarClient): Promise<ZoneLabels> {
  if (isRecurring(p, current)) {
    const zone = await seriesZone(p, current, client);
    return { start: zone, end: zone };
  }
  return {
    start: reschedule.kind === "end" ? current.start?.timeZone : p.timeZone ?? current.start?.timeZone,
    end: p.timeZone ?? current.end?.timeZone,
  };
}

async function rescheduledTimes(p: UpdateArgs, reschedule: Reschedule, current: CalendarEvent, client: CalendarClient): Promise<TimePair> {
  const timed = reschedule.kind === "range" ? reschedule.range.kind === "datetime" : current.start?.dateTime !== undefined;
  const labels = timed ? await zoneLabels(p, reschedule, current, client) : {};
  const inputZone = client.zone(p.calendarId, p.timeZone);
  const times = await changedTimes(reschedule, current, inputZone, client.zone(p.calendarId, labels.end));
  return { start: relabel(times.start, labels.start), end: relabel(times.end, labels.end) };
}

async function rezonedTimes(p: UpdateArgs, current: CalendarEvent, client: CalendarClient): Promise<TimePair | undefined> {
  const stored = storedTimes(current);
  if (p.timeZone !== undefined) {
    if (!stored || "date" in stored.start) {
      fail("`timeZone` does not apply to an all-day event. To make it timed, pass both `start` and `end` as datetimes.");
    }
    return inZone(stored, p.timeZone);
  }
  if (!stored) return undefined;
  const times = await seriesTimes(stored, isRecurring(p, current), () => seriesZone(p, current, client));
  return times === stored ? undefined : times;
}

async function schedulePatch(p: UpdateArgs, reschedule: Reschedule | undefined, current: CalendarEvent, client: CalendarClient) {
  const times = reschedule ? await rescheduledTimes(p, reschedule, current, client) : await rezonedTimes(p, current, client);
  if (!times) return {};
  validateEventTypeTimes(current.eventType, times);
  assertSchedulable(times);
  return { start: toPatchTime(times.start), end: toPatchTime(times.end) };
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

function assertSeriesWideVisibility(p: UpdateArgs, current: CalendarEvent): void {
  if (p.visibility === undefined || !current.recurringEventId) return;
  fail(`Google applies a visibility change on one occurrence to the whole series, so it is not changed per occurrence. To change visibility for the whole series, pass the series id "${current.recurringEventId}" as eventId.`, {
    resource: "event",
    resourceId: p.eventId,
    recurringEventId: current.recurringEventId,
  });
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
    "Naive datetimes are read in `timeZone`, else the calendar's own time zone. Each endpoint keeps the time zone it already has unless `timeZone` is passed; a recurring series keeps one shared time zone. `timeZone` alone (no `start`/`end`) moves a timed event into that zone keeping the same instants; it does not apply to all-day events. " +
    "`description` is rendered through Markdown to HTML by the server. " +
    "To add or remove guests, use `addAttendees` / `removeAttendees`: everyone else keeps their current response; removing someone who is not a guest is an error. " +
    "ATTENDEES WARNING: `attendees` REPLACES the entire attendee list and resets every responseStatus to needsAction; whether notifications are re-sent depends on `sendUpdates`. To accept/decline/tentatively respond for YOURSELF, use respond_to_event instead: it preserves everyone else's responses. " +
    "Optional extras: `recurrence`, `addGoogleMeet`, `colorId`, `visibility`, `availability` (busy/free), `reminders` and `guestPermissions`. " +
    "Drive attachments: `addAttachments` / `removeAttachments` edit the list incrementally; `attachments` REPLACES it (pass [] to remove all). " +
    "Cannot move an event between calendars or change its `eventType`. For a recurring-instance `eventId` (date-suffixed), the patch applies to that single occurrence only, except `visibility`: Google applies it to the whole series, so it is rejected on an occurrence; pass the series id (the occurrence's `recurringEventId`) to change visibility for the whole series. Returns the updated event including a fresh `updated` timestamp.",
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

    const current = await loadCurrent(client, p.calendarId, p.eventId);
    assertEventTypeOptions(current.eventType, p);
    assertSeriesWideVisibility(p, current);

    const patch = {
      ...options,
      ...(p.summary !== undefined && { summary: p.summary }),
      ...(p.description !== undefined && { description: renderMarkdown(p.description) }),
      ...(p.location !== undefined && { location: p.location }),
      ...(p.attendees !== undefined && { attendees: normalizeAttendees(p.attendees) }),
      ...(replacedAttachments && { attachments: replacedAttachments }),
      ...await schedulePatch(p, reschedule, current, client),
      ...attendeePatch(p, current),
      ...attachmentPatch(p, addedAttachments, current),
    };
    return writeEvent(client, {
      method: "PATCH",
      path: eventPath(p.calendarId, p.eventId),
      body: patch,
      sendUpdates: p.sendUpdates,
      ifMatch: current.etag,
      eventType: current.eventType,
      ctx: { operation: "update calendar event", resource: "event", resourceId: p.eventId },
    });
  },
});
