import { randomUUID } from "node:crypto";
import { ToolFailure, fail } from "./failure.js";
import type { EventAttachment, EventAttendee } from "./event-model.js";
import type { TimePair } from "./schedule.js";

export interface ReminderOverride {
  method: "email" | "popup";
  minutes: number;
}

export interface GuestPermissions {
  canModify?: boolean;
  canInviteOthers?: boolean;
  canSeeOtherGuests?: boolean;
}

export type AutoDeclineMode = "declineNone" | "declineAllConflictingInvitations" | "declineOnlyNewConflictingInvitations";

export interface OutOfOfficeSettings {
  autoDeclineMode?: AutoDeclineMode;
  declineMessage?: string;
}

export interface FocusTimeSettings extends OutOfOfficeSettings {
  chatStatus?: "available" | "doNotDisturb";
}

export interface WorkingLocationSettings {
  type?: "homeOffice" | "customLocation" | "officeLocation";
  label?: string;
  buildingId?: string;
  floorId?: string;
  floorSectionId?: string;
  deskId?: string;
}

export type CreatableEventType = "default" | "outOfOffice" | "focusTime" | "workingLocation";
type Visibility = "default" | "public" | "private" | "confidential";
type Transparency = "opaque" | "transparent";

export interface EventOptions {
  recurrence?: string[];
  colorId?: string;
  visibility?: Visibility;
  availability?: "busy" | "free";
  reminders?: { useDefault?: boolean; overrides?: ReminderOverride[] };
  addGoogleMeet?: boolean;
  guestPermissions?: GuestPermissions;
  eventType?: CreatableEventType;
  outOfOffice?: OutOfOfficeSettings;
  focusTime?: FocusTimeSettings;
  workingLocation?: WorkingLocationSettings;
}

export interface EventOptionsBody {
  recurrence?: string[];
  colorId?: string;
  visibility?: Visibility;
  transparency?: Transparency;
  reminders?: { useDefault: boolean; overrides?: ReminderOverride[] };
  conferenceData?: { createRequest: { requestId: string; conferenceSolutionKey: { type: "hangoutsMeet" } } };
  guestsCanModify?: boolean;
  guestsCanInviteOthers?: boolean;
  guestsCanSeeOtherGuests?: boolean;
  eventType?: CreatableEventType;
  outOfOfficeProperties?: { autoDeclineMode: AutoDeclineMode; declineMessage?: string };
  focusTimeProperties?: { autoDeclineMode: AutoDeclineMode; chatStatus: "available" | "doNotDisturb"; declineMessage?: string };
  workingLocationProperties?: Record<string, unknown>;
}

interface EventTypeRule {
  transparency: Transparency;
  visibility?: Visibility;
  timedOnly?: boolean;
  oneDayWhenAllDay?: boolean;
}

const EVENT_TYPE_RULES: Partial<Record<string, EventTypeRule>> = {
  outOfOffice: { transparency: "opaque", timedOnly: true },
  focusTime: { transparency: "opaque", timedOnly: true },
  workingLocation: { transparency: "transparent", visibility: "public", oneDayWhenAllDay: true },
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
      if (type === "customLocation") return { workingLocationProperties: { type, customLocation: label ? { label } : {} } };
      const officeLocation = Object.fromEntries(Object.entries({ label, ...office }).filter(([, v]) => v !== undefined));
      return { workingLocationProperties: { type, officeLocation } };
    }
    default:
      return {};
  }
}

function applyEventTypeRule(body: EventOptionsBody, opts: EventOptions, eventType: string): void {
  const rule = EVENT_TYPE_RULES[eventType];
  if (!rule) return;
  const availability = rule.transparency === "transparent" ? "free" : "busy";
  if (opts.availability !== undefined && opts.availability !== availability) {
    fail(`${eventType} events must be ${availability}; omit \`availability\` or pass "${availability}"`, { eventType });
  }
  body.transparency = rule.transparency;
  if (rule.visibility) {
    if (opts.visibility !== undefined && opts.visibility !== rule.visibility) {
      fail(`${eventType} events must be ${rule.visibility}; omit \`visibility\` or pass "${rule.visibility}"`, { eventType });
    }
    body.visibility = rule.visibility;
  }
}

export function buildEventOptions(opts: EventOptions, requestId: () => string = randomUUID): EventOptionsBody {
  const body: EventOptionsBody = {};
  if (opts.recurrence !== undefined) body.recurrence = opts.recurrence;
  if (opts.colorId !== undefined) body.colorId = opts.colorId;
  if (opts.visibility !== undefined) body.visibility = opts.visibility;
  if (opts.availability !== undefined) body.transparency = opts.availability === "free" ? "transparent" : "opaque";
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
    applyEventTypeRule(body, opts, eventType);
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

export function withEventTypeHint(err: unknown, eventType: string | undefined): unknown {
  if (!(err instanceof ToolFailure) || err.payload.status !== 400 || !eventType || !EVENT_TYPE_RULES[eventType]) return err;
  return new ToolFailure({
    ...err.payload,
    eventType,
    hint: `${eventType} events are only accepted on the user's primary calendar (calendarId "primary"); out-of-office and focus-time events must be timed, not all-day; working-location events must fit in one day.`,
  });
}

export type AttendeeInput =
  | string
  | {
      email: string;
      displayName?: string;
      optional?: boolean;
      additionalGuests?: number;
      resource?: boolean;
      responseStatus?: "needsAction" | "accepted" | "declined" | "tentative";
    };

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

const emailKey = (email: string | undefined) => email?.trim().toLowerCase();

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

export type AttachmentInput = string | { fileUrl?: string; fileId?: string; title?: string };

export const MAX_ATTACHMENTS = 25;
const DRIVE_FILE_ID_RE = /^[A-Za-z0-9_-]{4,}$/;

function assertAttachmentCap(count: number): void {
  if (count > MAX_ATTACHMENTS) fail(`An event can hold at most ${MAX_ATTACHMENTS} attachments; this change would leave ${count}.`);
}

function driveIdFromUrl(url: string): string | undefined {
  return url.match(/[?&]id=([A-Za-z0-9_-]+)/)?.[1] ?? url.match(/\/d\/([A-Za-z0-9_-]+)/)?.[1];
}

function driveRef(raw: string): { fileUrl: string; fileId?: string } {
  const ref = raw.trim();
  if (/^https?:\/\//.test(ref)) return { fileUrl: ref, fileId: driveIdFromUrl(ref) };
  if (DRIVE_FILE_ID_RE.test(ref)) return { fileUrl: `https://drive.google.com/open?id=${ref}`, fileId: ref };
  fail(`Attachment "${ref}" is neither a Drive URL nor a Drive file id`);
}

function attachmentKeys(a: { fileUrl: string; fileId?: string }): string[] {
  return [a.fileId, a.fileUrl, driveIdFromUrl(a.fileUrl)].filter((k): k is string => !!k);
}

export function normalizeAttachments(input: AttachmentInput[]): EventAttachment[] {
  assertAttachmentCap(input.length);
  return input.map((a) => {
    const raw = typeof a === "string" ? { fileUrl: a } : a;
    const { fileUrl } = driveRef(raw.fileUrl ?? raw.fileId ?? "");
    return { fileUrl, ...(raw.title && { title: raw.title }) };
  });
}

export function mergeAttachments(existing: EventAttachment[] = [], add: EventAttachment[], remove: string[]): EventAttachment[] {
  const removals = remove.map((r) => ({ ref: r.trim(), keys: new Set(attachmentKeys(driveRef(r))) }));
  const matches = (a: EventAttachment, keys: Set<string>) => attachmentKeys(a).some((k) => keys.has(k));
  const unmatched = removals.filter(({ keys }) => !existing.some((a) => matches(a, keys)));
  if (unmatched.length > 0) {
    fail(`No attachment matches ${unmatched.map((u) => u.ref).join(", ")}, so nothing was changed.`, {
      attachments: existing.map((a) => a.fileId ?? a.fileUrl),
    });
  }
  const kept = existing.filter((a) => !removals.some(({ keys }) => matches(a, keys)));
  const present = new Set(kept.flatMap(attachmentKeys));
  for (const a of add) {
    const keys = attachmentKeys(a);
    if (keys.some((k) => present.has(k))) continue;
    keys.forEach((k) => present.add(k));
    kept.push(a);
  }
  assertAttachmentCap(kept.length);
  return kept;
}
