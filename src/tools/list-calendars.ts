import { z } from "zod";
import { calendarSchema, type CalendarListResponse } from "../lib/event-model.js";
import { defineTool } from "./define.js";

export const listCalendars = defineTool({
  name: "list_calendars",
  description:
    "List all Google Calendars the authenticated user has access to (primary, shared, subscribed, secondary). " +
    "Use this when the user names a calendar (e.g. \"my work calendar\", \"team calendar\") and you need its ID; for the user's MAIN calendar you do NOT need to call this first: pass calendarId='primary' to the other tools. " +
    "Returns up to `maxResults` items; if `nextPageToken` is returned, paginate by passing it back as `pageToken`.",
  readOnlyHint: true,
  outputSchema: {
    calendars: z.array(calendarSchema),
    nextPageToken: z.string().nullable(),
    message: z.string().optional(),
  },
  schema: {
    maxResults: z.coerce.number().int().min(1).max(250).optional().default(100).describe("Calendars to return per page (1-250). Default: 100."),
    pageToken: z.string().optional().describe("Pagination token from a prior call's `nextPageToken`."),
  },
  async run({ maxResults, pageToken }, client) {
    const data = await client.call<CalendarListResponse>(
      "/users/me/calendarList",
      { query: { maxResults: String(maxResults), pageToken } },
      { operation: "list calendars" },
    );
    const calendars = data?.items ?? [];
    if (calendars.length === 0) return { calendars: [], nextPageToken: null, message: "No calendars found" };
    return {
      calendars: calendars.map((cal) => ({
        id: cal.id,
        summary: cal.summary,
        description: cal.description,
        timeZone: cal.timeZone,
        accessRole: cal.accessRole,
        primary: cal.primary || false,
      })),
      nextPageToken: data?.nextPageToken || null,
    };
  },
});
