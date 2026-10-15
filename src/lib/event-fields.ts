// Pure helpers for the optional event fields shared by create_event and
// update_event (recurrence, colour, visibility, availability, reminders,
// Meet links) and for incremental attendee edits. No I/O here

import { randomUUID } from "node:crypto";

export interface ReminderOverride {
  method: "email" | "popup";
  minutes: number;
}

export interface EventOptions {
  recurrence?: string[];
  colorId?: string;
  visibility?: "default" | "public" | "private" | "confidential";
  availability?: "busy" | "free";
  reminders?: { useDefault?: boolean; overrides?: ReminderOverride[] };
  addGoogleMeet?: boolean;
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
  return body;
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
