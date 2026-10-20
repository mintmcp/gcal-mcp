import { domainToASCII } from "node:url";
import { z } from "zod";
import { fail } from "./failure.js";
import type { EventAttendee } from "./event-model.js";

export function isEmailAddress(value: string): boolean {
  const parts = value.split("@");
  return parts.length === 2 && parts[0] !== "" && parts[1] !== "" && !/\s/.test(value);
}

export const emailSchema = z.string().trim().refine(isEmailAddress, "Expected an email address like name@example.com");

export const attendeeInputSchema = z.union([
  emailSchema,
  z.object({
    email: emailSchema,
    displayName: z.string().optional(),
    optional: z.boolean().optional(),
    additionalGuests: z.coerce.number().int().min(0).optional().describe("Number of extra guests this attendee brings."),
    resource: z.boolean().optional().describe("true when the email is a room or other resource calendar."),
    responseStatus: z.enum(["needsAction", "accepted", "declined", "tentative"]).optional().describe("Pre-set RSVP for this attendee (normally left out)."),
  }),
]);

export type AttendeeInput = z.infer<typeof attendeeInputSchema>;

export function normalizeAttendees(input: AttendeeInput[]): EventAttendee[] {
  return input.map((a) => {
    if (typeof a === "string") return { email: a };
    return {
      email: a.email,
      ...(a.displayName && { displayName: a.displayName }),
      ...(a.optional === true && { optional: true }),
      ...(a.additionalGuests !== undefined && a.additionalGuests > 0 && { additionalGuests: a.additionalGuests }),
      ...(a.resource === true && { resource: true }),
      ...(a.responseStatus !== undefined && { responseStatus: a.responseStatus }),
    };
  });
}

export function describeAttendeeRoster(attendees: EventAttendee[], sampleSize = 3): string {
  const emails = attendees.map((a) => a.email).filter((e): e is string => typeof e === "string");
  const sample = emails.slice(0, sampleSize).join(", ");
  const rest = emails.length - sampleSize;
  return `${attendees.length} attendee(s)${sample ? `, e.g. ${sample}${rest > 0 ? ` and ${rest} more` : ""}` : ""}`;
}

function emailKey(email: string | undefined): string | undefined {
  const address = email?.trim().toLowerCase();
  const at = address?.lastIndexOf("@") ?? -1;
  if (!address || at < 0) return address;
  const domain = address.slice(at + 1);
  return `${address.slice(0, at)}@${domainToASCII(domain) || domain}`;
}

export function mergeAttendees(existing: EventAttendee[] = [], add: EventAttendee[], remove: string[]): EventAttendee[] {
  const removed = new Set(remove.map(emailKey));
  const unmatched = remove.filter((r) => !existing.some((a) => emailKey(a.email) === emailKey(r)));
  if (unmatched.length > 0) {
    fail(`No attendee matches ${unmatched.join(", ")}, so nothing was changed.`, { attendees: describeAttendeeRoster(existing) });
  }
  const kept = existing.filter((a) => !removed.has(emailKey(a.email)));
  const present = new Set(kept.map((a) => emailKey(a.email)));
  for (const a of add) {
    const key = emailKey(a.email);
    if (present.has(key)) continue;
    present.add(key);
    kept.push(a);
  }
  return kept;
}
