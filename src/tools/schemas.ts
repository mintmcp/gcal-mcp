import { z } from "zod";
import { isValidTimeZone } from "../lib/datetime.js";

export const calendarIdSchema = (description: string) => z.string().optional().default("primary").describe(description);

export const timeZoneSchema = (description: string) =>
  z.string().refine(isValidTimeZone, "Unknown IANA time zone; use a name like \"America/New_York\" or \"UTC\"").optional().describe(description);

export const inputTimeZoneSchema = timeZoneSchema('IANA timezone (e.g. "America/Los_Angeles") used to interpret naive datetimes. Defaults to the calendar\'s own time zone.');

export const sendUpdatesSchema = (description: string) =>
  z.enum(["all", "externalOnly", "none"]).optional().default("all").describe(description);
