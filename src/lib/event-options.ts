import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ToolFailure, fail } from "./failure.js";
import type { TimePair } from "./schedule.js";

export const CREATABLE_EVENT_TYPES = ["default", "outOfOffice", "focusTime", "workingLocation"] as const;
export const EVENT_TYPES = [...CREATABLE_EVENT_TYPES, "birthday", "fromGmail"] as const;

const autoDeclineModeSchema = z.enum(["declineNone", "declineAllConflictingInvitations", "declineOnlyNewConflictingInvitations"]);
const visibilitySchema = z.enum(["default", "public", "private", "confidential"]);
const availabilitySchema = z.enum(["busy", "free"]);
const reminderOverrideSchema = z.object({ method: z.enum(["email", "popup"]), minutes: z.coerce.number().int().min(0) });

export const eventTypeInputSchema = {
  eventType: z
    .enum(CREATABLE_EVENT_TYPES)
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
      label: z.string().optional().describe("Required for customLocation; optional display label for officeLocation."),
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
  visibility: visibilitySchema
    .optional()
    .describe("Who can see event details: default (calendar setting), public, or private (attendees only)."),
  availability: availabilitySchema
    .optional()
    .describe("Whether the event blocks time: busy (default) or free (shows as available)."),
  reminders: z
    .object({
      useDefault: z.boolean().optional().describe("true: use the calendar default reminders. false with no overrides: no reminders at all."),
      overrides: z
        .array(reminderOverrideSchema)
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

const eventOptionsSchema = z.object({ ...eventOptionsInputSchema, ...eventTypeInputSchema });

export type EventOptions = z.infer<typeof eventOptionsSchema>;
type CreatableEventType = (typeof CREATABLE_EVENT_TYPES)[number];
type Visibility = z.infer<typeof visibilitySchema>;
type Availability = z.infer<typeof availabilitySchema>;
type AutoDeclineMode = z.infer<typeof autoDeclineModeSchema>;
type ChatStatus = NonNullable<NonNullable<EventOptions["focusTime"]>["chatStatus"]>;

const TRANSPARENCY = { busy: "opaque", free: "transparent" } as const;

export interface EventOptionsBody {
  recurrence?: string[];
  colorId?: string;
  visibility?: Visibility;
  transparency?: (typeof TRANSPARENCY)[Availability];
  reminders?: { useDefault: boolean; overrides?: z.infer<typeof reminderOverrideSchema>[] };
  conferenceData?: { createRequest: { requestId: string; conferenceSolutionKey: { type: "hangoutsMeet" } } };
  guestsCanModify?: boolean;
  guestsCanInviteOthers?: boolean;
  guestsCanSeeOtherGuests?: boolean;
  eventType?: CreatableEventType;
  outOfOfficeProperties?: { autoDeclineMode: AutoDeclineMode; declineMessage?: string };
  focusTimeProperties?: { autoDeclineMode: AutoDeclineMode; chatStatus: ChatStatus; declineMessage?: string };
  workingLocationProperties?: Record<string, unknown>;
}

interface EventTypeRule {
  availability: Availability;
  visibility?: Visibility;
  timedOnly?: boolean;
  oneDayWhenAllDay?: boolean;
}

const EVENT_TYPE_RULES: Partial<Record<string, EventTypeRule>> = {
  outOfOffice: { availability: "busy", timedOnly: true },
  focusTime: { availability: "busy", timedOnly: true },
  workingLocation: { availability: "free", visibility: "public", oneDayWhenAllDay: true },
};

const TYPE_SETTINGS = ["outOfOffice", "focusTime", "workingLocation"] as const;

function resolveEventType(opts: EventOptions): CreatableEventType | undefined {
  const implied = TYPE_SETTINGS.filter((type) => opts[type] !== undefined);
  if (implied.length > 1) fail(`Pass settings for one event type only, got ${implied.join(" and ")}`);
  const eventType = opts.eventType ?? implied[0];
  if (implied[0] && eventType !== implied[0]) {
    fail(`\`${implied[0]}\` settings were given but eventType is "${eventType}"`);
  }
  return eventType;
}

function eventTypeProperties(opts: EventOptions, eventType: CreatableEventType): EventOptionsBody {
  switch (eventType) {
    case "outOfOffice": {
      const { autoDeclineMode = "declineAllConflictingInvitations", declineMessage } = opts.outOfOffice ?? {};
      return { outOfOfficeProperties: { autoDeclineMode, ...(declineMessage !== undefined && { declineMessage }) } };
    }
    case "focusTime": {
      const { autoDeclineMode = "declineNone", chatStatus = "doNotDisturb", declineMessage } = opts.focusTime ?? {};
      return { focusTimeProperties: { autoDeclineMode, chatStatus, ...(declineMessage !== undefined && { declineMessage }) } };
    }
    case "workingLocation": {
      const { type = "homeOffice", label, ...office } = opts.workingLocation ?? {};
      if (type === "homeOffice") return { workingLocationProperties: { type, homeOffice: {} } };
      if (type === "customLocation") {
        if (!label?.trim()) fail('A customLocation working location needs a non-empty `label`, e.g. {type: "customLocation", label: "Client office"}.');
        return { workingLocationProperties: { type, customLocation: { label } } };
      }
      const officeLocation = Object.fromEntries(Object.entries({ label, ...office }).filter(([, v]) => v !== undefined));
      return { workingLocationProperties: { type, officeLocation } };
    }
    default:
      return {};
  }
}

export function assertEventTypeOptions(eventType: string | undefined, opts: Pick<EventOptions, "availability" | "visibility">): void {
  const rule = eventType ? EVENT_TYPE_RULES[eventType] : undefined;
  if (!rule) return;
  if (opts.availability !== undefined && opts.availability !== rule.availability) {
    fail(`${eventType} events must be ${rule.availability}; omit \`availability\` or pass "${rule.availability}"`, { eventType });
  }
  if (rule.visibility && opts.visibility !== undefined && opts.visibility !== rule.visibility) {
    fail(`${eventType} events must be ${rule.visibility}; omit \`visibility\` or pass "${rule.visibility}"`, { eventType });
  }
}

export function buildEventOptions(opts: EventOptions, requestId: () => string = randomUUID): EventOptionsBody {
  const body: EventOptionsBody = {};
  if (opts.recurrence !== undefined) body.recurrence = opts.recurrence;
  if (opts.colorId !== undefined) body.colorId = opts.colorId;
  if (opts.visibility !== undefined) body.visibility = opts.visibility;
  if (opts.availability !== undefined) body.transparency = TRANSPARENCY[opts.availability];
  if (opts.reminders !== undefined) {
    const { useDefault, overrides } = opts.reminders;
    if (overrides && overrides.length > 0) body.reminders = { useDefault: false, overrides };
    else if (useDefault === false) body.reminders = { useDefault: false, overrides: [] };
    else body.reminders = { useDefault: true };
  }
  if (opts.addGoogleMeet) {
    body.conferenceData = { createRequest: { requestId: requestId(), conferenceSolutionKey: { type: "hangoutsMeet" } } };
  }
  const { canModify, canInviteOthers, canSeeOtherGuests } = opts.guestPermissions ?? {};
  if (canModify !== undefined) body.guestsCanModify = canModify;
  if (canInviteOthers !== undefined) body.guestsCanInviteOthers = canInviteOthers;
  if (canSeeOtherGuests !== undefined) body.guestsCanSeeOtherGuests = canSeeOtherGuests;
  const eventType = resolveEventType(opts);
  if (eventType !== undefined) {
    body.eventType = eventType;
    Object.assign(body, eventTypeProperties(opts, eventType));
    const rule = EVENT_TYPE_RULES[eventType];
    if (rule) {
      assertEventTypeOptions(eventType, opts);
      body.transparency = TRANSPARENCY[rule.availability];
      if (rule.visibility) body.visibility = rule.visibility;
    }
  }
  return body;
}

export function validateEventTypeTimes(eventType: string | undefined, times: TimePair): void {
  const rule = eventType ? EVENT_TYPE_RULES[eventType] : undefined;
  if (!rule || !("date" in times.start) || !("date" in times.end)) return;
  if (rule.timedOnly) fail(`${eventType} events must be timed: pass datetime \`start\`/\`end\`, not dates.`, { eventType });
  const days = (Date.parse(`${times.end.date}T00:00:00Z`) - Date.parse(`${times.start.date}T00:00:00Z`)) / 86_400_000;
  if (rule.oneDayWhenAllDay && days !== 1) {
    fail(`An all-day ${eventType} event covers exactly one day: \`end\` must be the day after \`start\`. Create one event per day.`, { eventType });
  }
}

function eventTypeHint(eventType: string, rule: EventTypeRule): string {
  const rules = [
    'only accepted on the user\'s primary calendar (calendarId "primary")',
    rule.timedOnly && "must be timed, not all-day",
    rule.oneDayWhenAllDay && "an all-day one must cover exactly one day",
    `always ${rule.availability}${rule.visibility ? ` and ${rule.visibility}` : ""}`,
  ];
  return `${eventType} events: ${rules.filter(Boolean).join("; ")}.`;
}

export function withEventTypeHint(err: unknown, eventType: string | undefined): unknown {
  const rule = eventType ? EVENT_TYPE_RULES[eventType] : undefined;
  if (!(err instanceof ToolFailure) || err.payload.status !== 400 || !eventType || !rule) return err;
  return new ToolFailure({ ...err.payload, eventType, hint: eventTypeHint(eventType, rule) });
}
