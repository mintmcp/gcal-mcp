import { z } from "zod";
import { eventPath } from "../google/client.js";
import { WRITE_SCOPE, defineTool } from "./define.js";
import { calendarIdSchema, sendUpdatesSchema } from "./schemas.js";

export const deleteEvent = defineTool({
  name: "delete_event",
  description:
    "Permanently delete an event by `eventId`; there is NO undo. " +
    "Sends cancellation notifications to attendees by default; set `sendUpdates: 'none'` to delete silently. " +
    "Returns {success, eventId, message} on success. " +
    "If the event was already deleted, Google returns 410 and this tool surfaces a structured error; do not retry.",
  scope: WRITE_SCOPE,
  destructiveHint: true,
  outputSchema: {
    success: z.boolean(),
    eventId: z.string(),
    message: z.string(),
  },
  schema: {
    calendarId: calendarIdSchema('Calendar containing the event. Defaults to "primary".'),
    eventId: z.string().describe("Event ID to delete (from get_calendar_events or create_event)."),
    sendUpdates: sendUpdatesSchema("Cancellation notification behaviour. all / externalOnly / none."),
  },
  async run({ calendarId, eventId, sendUpdates }, client) {
    await client.call(
      eventPath(calendarId, eventId),
      { method: "DELETE", query: { sendUpdates } },
      { operation: "delete calendar event", resource: "event", resourceId: eventId },
    );
    return { success: true, eventId, message: `Event ${eventId} successfully deleted from calendar ${calendarId}` };
  },
});
