import { z } from "zod";
import { eventPath, type CalendarClient } from "../google/client.js";
import { describeAttendeeRoster } from "../lib/attendees.js";
import { eventSchema, toStructuredEvent, type CalendarEvent, type EventAttendee } from "../lib/event-model.js";
import { ToolFailure, fail } from "../lib/failure.js";
import { WRITE_SCOPE, defineTool } from "./define.js";
import { calendarIdSchema, sendUpdatesSchema } from "./schemas.js";

export type CallerAttendeeMatch =
  | { kind: "found"; attendee: EventAttendee }
  | { kind: "notFound" }
  | { kind: "unverifiableCalendar" };

export function identifyCallerAttendee(
  attendees: EventAttendee[],
  callerEmail: string | undefined,
  calendarId: string,
): CallerAttendeeMatch {
  const target = callerEmail ? callerEmail.toLowerCase() : undefined;
  const byEmail = target ? attendees.find((a) => a.email?.toLowerCase() === target) : undefined;

  const ownCalendar = calendarId === "primary" || (target !== undefined && calendarId.toLowerCase() === target);
  if (ownCalendar) {
    const match = byEmail || attendees.find((a) => a.self === true);
    return match ? { kind: "found", attendee: match } : { kind: "notFound" };
  }

  if (!target) return { kind: "unverifiableCalendar" };
  return byEmail ? { kind: "found", attendee: byEmail } : { kind: "notFound" };
}

function resolveCallerEmail(client: CalendarClient): Promise<string | undefined> {
  return client.calendar("primary").then(({ id }) => id?.toLowerCase(), () => undefined);
}

function rsvpResult(event: CalendarEvent, myResponseStatus: string, message: string, myComment: string | undefined) {
  return {
    ...toStructuredEvent(event),
    myResponseStatus,
    ...(myComment && { myComment }),
    message,
  };
}

function submittedButUnconfirmed(responseStatus: string, eventId: string, reason: string) {
  return `Your ${responseStatus} response to event "${eventId}" WAS submitted successfully, but ${reason}. Do NOT retry: retrying would re-notify every attendee. Read the event back to confirm.`;
}

export const respondToEvent = defineTool({
  name: "respond_to_event",
  description:
    "RSVP to a Google Calendar event as the authenticated user ONLY (accept, decline, or tentatively accept). " +
    "Use this, NOT update_event, to set your own response: update_event replaces the whole attendee list and resets everyone's responseStatus to needsAction, whereas this tool reads the event, changes ONLY your own attendee entry (matched by your own email address), and echoes back every other attendee untouched so their responses are preserved. " +
    "Always prefer calendarId='primary' (the default): on a shared or delegated calendar your attendee entry cannot always be identified safely. " +
    "For a recurring event, passing the series eventId responds for the ENTIRE series, while passing a single instance ID ('<eventId>_<UTC timestamp>', e.g. 'abc123_20240115T170000Z') responds for that one occurrence only. " +
    "Optionally attach a `comment` for the organizer. `sendUpdates` controls whether your response notifies others. " +
    "Returns the event with your updated response {id, summary, myResponseStatus, myComment, attendees, ...}, where myComment is your currently stored response comment (omitted when you have none).",
  scope: WRITE_SCOPE,
  outputSchema: {
    ...eventSchema.shape,
    myResponseStatus: z.string(),
    myComment: z.string().optional(),
    message: z.string(),
  },
  schema: {
    calendarId: calendarIdSchema('Calendar the event lives on. Defaults to "primary" (your own calendar), which is required for self-detection.'),
    eventId: z
      .string()
      .describe("Event ID to respond to (from get_calendar_events). For a recurring event, the series ID responds for the whole series; a single instance ID ('<eventId>_<UTC timestamp>') responds for that occurrence only."),
    responseStatus: z.enum(["accepted", "declined", "tentative"]).describe("Your RSVP: accepted, declined, or tentative."),
    comment: z.string().optional().describe("Optional response comment shown to the organizer."),
    sendUpdates: sendUpdatesSchema("Whether to notify others of your response. all / externalOnly / none."),
  },
  async run({ calendarId, eventId, responseStatus, comment, sendUpdates }, client) {
    const eventRef = { resource: "event", resourceId: eventId };
    const callerEmail = calendarId === "primary" ? Promise.resolve(undefined) : resolveCallerEmail(client);

    for (let attempt = 1; ; attempt++) {
      const [email, event] = await Promise.all([callerEmail, client.getEvent(calendarId, eventId, "load event to respond to")]);
      const attendees = event.attendees ?? [];
      const eventLabel = event.summary || eventId;

      if (event.status === "cancelled") {
        fail(`Event "${eventLabel}" has been cancelled, so there is nothing to respond to.`, eventRef);
      }
      const match = identifyCallerAttendee(attendees, email, calendarId);
      if (match.kind === "unverifiableCalendar") {
        fail(`Your email address could not be determined, so your attendee entry on calendar "${calendarId}" cannot be proven to be yours (Google's 'self' flag identifies the calendar owner, not you). Call this tool again with calendarId='primary' to RSVP on your own calendar.`, eventRef);
      }
      if (match.kind === "notFound") {
        if (event.attendeesOmitted === true) {
          fail(`Google truncated the guest list for event "${eventLabel}", so your attendee entry could not be located. Please RSVP in Google Calendar directly.`, eventRef);
        }
        fail(
          attendees.length === 0
            ? `Event "${eventLabel}" has no attendees, so there is no invitation for you to respond to.`
            : `Could not find your attendee entry on event "${eventLabel}". Make sure you are invited and that calendarId is your own calendar (use "primary").`,
          { ...eventRef, attendees: describeAttendeeRoster(attendees) },
        );
      }

      const self = match.attendee;
      if (self.responseStatus === responseStatus && (comment === undefined || self.comment === comment)) {
        return rsvpResult(event, responseStatus, `Your response to "${eventLabel}" was already ${responseStatus}, so nothing was changed and no notifications were sent.`, self.comment);
      }
      if (event.attendeesOmitted === true) {
        fail(`Google truncated the guest list for event "${eventLabel}", so responding here would delete the attendees it left out. Please RSVP in Google Calendar directly.`, eventRef);
      }

      let updated: CalendarEvent;
      try {
        updated = await client.event(
          eventPath(calendarId, eventId),
          {
            method: "PATCH",
            query: { sendUpdates },
            body: { attendees: attendees.map((a) => (a === self ? { ...a, responseStatus, ...(comment !== undefined && { comment }) } : a)) },
            ifMatch: event.etag,
          },
          { operation: "submit your event response", ...eventRef },
          submittedButUnconfirmed(responseStatus, eventId, "Google returned an unexpected response with no event id, so it could not be confirmed"),
        );
      } catch (err) {
        if (!(err instanceof ToolFailure) || err.payload.status !== 412) throw err;
        if (attempt === 1) continue;
        fail(`Event "${eventId}" is being changed by someone else right now, so your response was not saved (retrying immediately would risk overwriting their change). Try again in a moment.`, eventRef);
      }

      const stored = identifyCallerAttendee(updated.attendees ?? [], email, calendarId);
      const storedStatus = stored.kind === "found" ? stored.attendee.responseStatus : undefined;
      const eventName = updated.summary || eventId;
      const message = !storedStatus
        ? `Your ${responseStatus} response to "${eventName}" was submitted, but Google's reply did not include your attendee entry, so the stored value could not be confirmed.`
        : storedStatus !== responseStatus
          ? `Your response to "${eventName}" was submitted as ${responseStatus}, but Google reports it as ${storedStatus}.`
          : `Your response to "${eventName}" was set to ${storedStatus}.`;
      return rsvpResult(updated, storedStatus || "unknown", message, stored.kind === "found" ? stored.attendee.comment : undefined);
    }
  },
});
