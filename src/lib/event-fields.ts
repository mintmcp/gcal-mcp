// Pure helpers for the optional event fields shared by create_event and
// update_event (recurrence, colour, visibility, availability, reminders,
// Meet links, guest permissions, event types, attachments) and for
// incremental attendee and attachment edits. No I/O here

import { randomUUID } from "node:crypto";

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

export interface EventOptions {
  recurrence?: string[];
  colorId?: string;
  visibility?: "default" | "public" | "private" | "confidential";
  availability?: "busy" | "free";
  reminders?: { useDefault?: boolean; overrides?: ReminderOverride[] };
  addGoogleMeet?: boolean;
  guestPermissions?: GuestPermissions;
  eventType?: CreatableEventType;
  outOfOffice?: OutOfOfficeSettings;
  focusTime?: FocusTimeSettings;
  workingLocation?: WorkingLocationSettings;
}

const TYPE_SETTINGS: Array<[CreatableEventType, keyof EventOptions]> = [
  ["outOfOffice", "outOfOffice"],
  ["focusTime", "focusTime"],
  ["workingLocation", "workingLocation"],
];

/**
 * The event type to send: the explicit one, else the one implied by the
 * settings object given. Settings for a different type are an error rather
 * than silently dropped
 */
function resolveEventType(opts: EventOptions): CreatableEventType | undefined {
  const implied = TYPE_SETTINGS.filter(([, key]) => opts[key] !== undefined).map(([type]) => type);
  if (implied.length > 1) throw new Error(`Pass settings for one event type only, got ${implied.join(" and ")}`);
  const eventType = opts.eventType ?? implied[0];
  if (implied[0] && eventType !== implied[0]) {
    throw new Error(`\`${implied[0]}\` settings were given but eventType is "${eventType}"`);
  }
  return eventType;
}

function buildEventTypeProperties(opts: EventOptions, eventType: CreatableEventType): Record<string, unknown> {
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
        if (!label) throw new Error("workingLocation.label is required for a customLocation working location");
        return { workingLocationProperties: { type, customLocation: { label } } };
      }
      const officeLocation = Object.fromEntries(
        Object.entries({ label, ...office }).filter(([, v]) => v !== undefined),
      );
      return { workingLocationProperties: { type, officeLocation } };
    }
    default:
      return {};
  }
}

/**
 * Translate the tool-level options into the Google Calendar event body
 * fragment they correspond to. Fields left undefined are omitted so a PATCH
 * leaves them untouched
 */
export function buildEventOptions(
  opts: EventOptions,
  requestId: () => string = randomUUID,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (opts.recurrence !== undefined) body.recurrence = opts.recurrence;
  if (opts.colorId !== undefined) body.colorId = opts.colorId;
  if (opts.visibility !== undefined) body.visibility = opts.visibility;
  if (opts.availability !== undefined) {
    body.transparency = opts.availability === "free" ? "transparent" : "opaque";
  }
  if (opts.reminders !== undefined) {
    const { useDefault, overrides } = opts.reminders;
    if (overrides && overrides.length > 0) {
      body.reminders = { useDefault: false, overrides };
    } else if (useDefault === false) {
      body.reminders = { useDefault: false, overrides: [] };
    } else {
      body.reminders = { useDefault: true };
    }
  }
  if (opts.addGoogleMeet) {
    body.conferenceData = {
      createRequest: { requestId: requestId(), conferenceSolutionKey: { type: "hangoutsMeet" } },
    };
  }
  if (opts.guestPermissions) {
    const { canModify, canInviteOthers, canSeeOtherGuests } = opts.guestPermissions;
    if (canModify !== undefined) body.guestsCanModify = canModify;
    if (canInviteOthers !== undefined) body.guestsCanInviteOthers = canInviteOthers;
    if (canSeeOtherGuests !== undefined) body.guestsCanSeeOtherGuests = canSeeOtherGuests;
  }
  const eventType = resolveEventType(opts);
  if (eventType !== undefined) {
    body.eventType = eventType;
    Object.assign(body, buildEventTypeProperties(opts, eventType));
  }
  // Google only stores working locations as public, non-blocking events
  if (eventType === "workingLocation") {
    if (opts.visibility !== undefined && opts.visibility !== "public") {
      throw new Error("workingLocation events must be public; omit `visibility` or pass \"public\"");
    }
    if (opts.availability === "busy") {
      throw new Error("workingLocation events must be free (non-blocking); omit `availability` or pass \"free\"");
    }
    body.visibility = "public";
    body.transparency = "transparent";
  }
  return body;
}

export interface AttachmentInput {
  fileUrl?: string;
  fileId?: string;
  title?: string;
}

export interface EventAttachment {
  fileUrl: string;
  title?: string;
  fileId?: string;
  [key: string]: unknown;
}

const DRIVE_FILE_ID_RE = /^[A-Za-z0-9_-]{4,}$/;

export const MAX_ATTACHMENTS = 25;

/**
 * Turn attachment inputs (a Drive URL, a bare Drive file id, or an object
 * naming either) into the `{fileUrl, title?}` entries Google stores. Google
 * resolves the Drive file behind the URL itself, so no Drive scope is needed
 */
export function normalizeAttachments(input: Array<string | AttachmentInput>): EventAttachment[] {
  return input.map((a) => {
    const raw = typeof a === "string" ? { fileUrl: a } : a;
    const ref = (raw.fileUrl ?? raw.fileId ?? "").trim();
    let fileUrl: string;
    if (/^https?:\/\//.test(ref)) fileUrl = ref;
    else if (DRIVE_FILE_ID_RE.test(ref)) fileUrl = `https://drive.google.com/open?id=${ref}`;
    else throw new Error(`Attachment "${ref}" is neither a Drive URL nor a Drive file id`);
    return { fileUrl, ...(raw.title && { title: raw.title }) };
  });
}

function attachmentKeys(a: { fileUrl?: string; fileId?: string }): string[] {
  const keys: string[] = [];
  if (a.fileId) keys.push(a.fileId);
  if (a.fileUrl) {
    keys.push(a.fileUrl);
    const id = a.fileUrl.match(/[?&]id=([A-Za-z0-9_-]+)/)?.[1] ?? a.fileUrl.match(/\/d\/([A-Za-z0-9_-]+)/)?.[1];
    if (id) keys.push(id);
  }
  return keys;
}

/**
 * Apply removals (by file id or url) then additions to an attachment list,
 * keeping surviving entries as Google returned them
 */
export function mergeAttachments(
  existing: EventAttachment[] | undefined,
  add: EventAttachment[],
  remove: string[],
): EventAttachment[] {
  const removed = new Set(remove.flatMap((r) => attachmentKeys(/^https?:\/\//.test(r) ? { fileUrl: r } : { fileId: r })));
  const kept = (existing ?? []).filter((a) => !attachmentKeys(a).some((k) => removed.has(k)));
  const present = new Set(kept.flatMap(attachmentKeys));
  for (const a of add) {
    const keys = attachmentKeys(a);
    if (keys.some((k) => present.has(k))) continue;
    keys.forEach((k) => present.add(k));
    kept.push(a);
  }
  if (kept.length > MAX_ATTACHMENTS) {
    throw new Error(`An event can hold at most ${MAX_ATTACHMENTS} attachments; this change would leave ${kept.length}`);
  }
  return kept;
}

export interface AttendeeLike {
  email: string;
  [key: string]: unknown;
}

/**
 * Apply removals then additions to an attendee list, keeping every surviving
 * entry byte-for-byte so Google does not reset its responseStatus
 */
export function mergeAttendees<T extends AttendeeLike>(
  existing: T[] | undefined,
  add: T[],
  remove: string[],
): T[] {
  const removed = new Set(remove.map((e) => e.toLowerCase()));
  const kept = (existing ?? []).filter((a) => !removed.has(a.email.toLowerCase()));
  const present = new Set(kept.map((a) => a.email.toLowerCase()));
  for (const a of add) {
    const key = a.email.toLowerCase();
    if (present.has(key)) continue;
    present.add(key);
    kept.push(a);
  }
  return kept;
}
