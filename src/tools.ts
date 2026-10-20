import { createEvent } from "./tools/create-event.js";
import { deleteEvent } from "./tools/delete-event.js";
import { getCalendarEvents } from "./tools/get-calendar-events.js";
import { getEvent } from "./tools/get-event.js";
import { getNextAvailability } from "./tools/get-next-availability.js";
import { listCalendars } from "./tools/list-calendars.js";
import { respondToEvent } from "./tools/respond-to-event.js";
import { updateEvent } from "./tools/update-event.js";

const TOOLS = [
  listCalendars,
  getCalendarEvents,
  getEvent,
  createEvent,
  updateEvent,
  respondToEvent,
  deleteEvent,
  getNextAvailability,
];

export class GoogleCalendarTools {
  static getTools() {
    return Object.fromEntries(TOOLS.map((tool) => [tool.name, tool]));
  }
}
