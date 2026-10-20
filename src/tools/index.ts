import type { RegisteredTool } from "./define.js";
import { createEvent } from "./create-event.js";
import { deleteEvent } from "./delete-event.js";
import { getCalendarEvents } from "./get-calendar-events.js";
import { getEvent } from "./get-event.js";
import { getNextAvailability } from "./get-next-availability.js";
import { listCalendars } from "./list-calendars.js";
import { respondToEvent } from "./respond-to-event.js";
import { updateEvent } from "./update-event.js";

export const TOOLS: readonly RegisteredTool[] = [
  listCalendars,
  getCalendarEvents,
  getEvent,
  createEvent,
  updateEvent,
  respondToEvent,
  deleteEvent,
  getNextAvailability,
];
