import { z } from "zod";
import { isValidTimeZone } from "../lib/datetime.js";

export const calendarIdSchema = (description: string) => z.string().optional().default("primary").describe(description);

export const timeZoneSchema = (description: string) =>
  z.string().refine(isValidTimeZone, "Unknown IANA time zone; use a name like \"America/New_York\" or \"UTC\"").optional().describe(description);

export const inputTimeZoneSchema = timeZoneSchema('IANA timezone (e.g. "America/Los_Angeles") used to interpret naive datetimes. Defaults to the calendar\'s own time zone.');

export const sendUpdatesSchema = (description: string) =>
  z.enum(["all", "externalOnly", "none"]).optional().default("all").describe(description);

export const emailSchema = z.string().trim().email();

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

export const attachmentInputSchema = z.union([
  z.string(),
  z.object({
    fileUrl: z.string().optional(),
    fileId: z.string().optional(),
    title: z.string().optional(),
  }),
]).describe("A Google Drive file: its URL (docs.google.com/... or drive.google.com/...), its file id, or {fileUrl|fileId, title?}.");

export const attachmentsDescription = "Google Drive files to attach (at most 25). Each item is a Drive URL, a Drive file id, or {fileUrl|fileId, title?}. Google resolves the file; the caller must have access to it.";

const autoDeclineModeSchema = z.enum(["declineNone", "declineAllConflictingInvitations", "declineOnlyNewConflictingInvitations"]);

export const eventTypeInputSchema = {
  eventType: z
    .enum(["default", "outOfOffice", "focusTime", "workingLocation"])
    .optional()
    .describe("Kind of event. outOfOffice, focusTime and workingLocation are only accepted on the primary calendar; outOfOffice and focusTime must be timed (not all-day) and busy; workingLocation is always public and free. Inferred from the matching settings object when omitted. Cannot be changed after creation."),
  outOfOffice: z
    .object({
      autoDeclineMode: autoDeclineModeSchema.optional().describe("Which conflicting invitations to decline automatically. Default: declineAllConflictingInvitations."),
      declineMessage: z.string().optional().describe("Message sent with the automatic declines."),
    })
    .optional()
    .describe("Settings for eventType=outOfOffice."),
  focusTime: z
    .object({
      autoDeclineMode: autoDeclineModeSchema.optional().describe("Default: declineNone."),
      chatStatus: z.enum(["available", "doNotDisturb"]).optional().describe("Google Chat status during the block. Default: doNotDisturb."),
      declineMessage: z.string().optional(),
    })
    .optional()
    .describe("Settings for eventType=focusTime."),
  workingLocation: z
    .object({
      type: z.enum(["homeOffice", "customLocation", "officeLocation"]).optional().describe("Default: homeOffice."),
      label: z.string().optional().describe("Optional display label for customLocation or officeLocation."),
      buildingId: z.string().optional(),
      floorId: z.string().optional(),
      floorSectionId: z.string().optional(),
      deskId: z.string().optional(),
    })
    .optional()
    .describe("Settings for eventType=workingLocation (all-day or timed)."),
};

export const eventOptionsInputSchema = {
  recurrence: z
    .array(z.string())
    .optional()
    .describe('Recurrence rules as RFC 5545 strings, e.g. ["RRULE:FREQ=WEEKLY;BYDAY=MO,WE"] (RRULE, RDATE, EXDATE). Makes the event a recurring series. On update, pass [] to stop the series from repeating.'),
  colorId: z
    .string()
    .optional()
    .describe('Event colour ID "1"-"11" (1 lavender, 2 sage, 3 grape, 4 flamingo, 5 banana, 6 tangerine, 7 peacock, 8 graphite, 9 blueberry, 10 basil, 11 tomato).'),
  visibility: z
    .enum(["default", "public", "private", "confidential"])
    .optional()
    .describe("Who can see event details: default (calendar setting), public, or private (attendees only)."),
  availability: z
    .enum(["busy", "free"])
    .optional()
    .describe("Whether the event blocks time: busy (default) or free (shows as available)."),
  reminders: z
    .object({
      useDefault: z.boolean().optional().describe("true: use the calendar default reminders. false with no overrides: no reminders at all."),
      overrides: z
        .array(z.object({ method: z.enum(["email", "popup"]), minutes: z.coerce.number().int().min(0) }))
        .optional()
        .describe("Custom reminders, each {method: email|popup, minutes before start}. Replaces the calendar defaults."),
    })
    .optional()
    .describe("Reminder settings. Omit to keep the calendar defaults (or, on update, the existing reminders)."),
  addGoogleMeet: z
    .boolean()
    .optional()
    .describe("true: ask Google to create a Google Meet link for the event. The link is returned as `hangoutLink` / `conferenceData`."),
  guestPermissions: z
    .object({
      canModify: z.boolean().optional().describe("Guests may edit the event. Google treats this as also letting guests see the guest list, so canModify=true overrides canSeeOtherGuests=false."),
      canInviteOthers: z.boolean().optional().describe("Guests may invite more people (Google default: true)."),
      canSeeOtherGuests: z.boolean().optional().describe("Guests can see the guest list (Google default: true). Ignored by Google when canModify is true."),
    })
    .optional()
    .describe("What attendees other than the organizer may do. Omit a flag to leave it unchanged."),
};
