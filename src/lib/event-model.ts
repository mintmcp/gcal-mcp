import { z } from "zod";
import { formatDateTimeWithDay } from "./datetime.js";

export type ConferenceEntryPoint = {
  entryPointType: string;
  uri: string;
  label?: string;
};

export type ConferenceData = {
  entryPoints?: ConferenceEntryPoint[];
  conferenceSolution?: {
    name?: string;
    iconUri?: string;
  };
  conferenceId?: string;
};

export interface EventAttendee {
  email?: string;
  displayName?: string;
  responseStatus?: string;
  optional?: boolean;
  organizer?: boolean;
  self?: boolean;
  resource?: boolean;
  additionalGuests?: number;
  comment?: string;
  [key: string]: unknown;
}

export interface EventAttachment {
  fileUrl: string;
  title?: string;
  fileId?: string;
  mimeType?: string;
  [key: string]: unknown;
}

export interface EventDateTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

export interface EventPerson {
  email?: string;
  displayName?: string;
  self?: boolean;
}

export interface CalendarEvent {
  id: string;
  summary?: string;
  organizer?: EventPerson;
  creator?: EventPerson;
  colorId?: string;
  visibility?: string;
  transparency?: string;
  eventType?: string;
  reminders?: { useDefault?: boolean; overrides?: Array<{ method: string; minutes: number }> };
  created?: string;
  start?: EventDateTime;
  end?: EventDateTime;
  recurrence?: string[];
  recurringEventId?: string;
  originalStartTime?: EventDateTime;
  description?: string;
  location?: string;
  attendees?: EventAttendee[];
  attendeesOmitted?: boolean;
  etag?: string;
  htmlLink?: string;
  hangoutLink?: string;
  conferenceData?: ConferenceData & {
    entryPoints?: Array<ConferenceEntryPoint & {
      pin?: string;
      accessCode?: string;
      meetingCode?: string;
      passcode?: string;
      password?: string;
    }>;
  };
  status?: string;
  updated?: string;
  attachments?: EventAttachment[];
  guestsCanModify?: boolean;
  guestsCanInviteOthers?: boolean;
  guestsCanSeeOtherGuests?: boolean;
  outOfOfficeProperties?: Record<string, unknown>;
  focusTimeProperties?: Record<string, unknown>;
  workingLocationProperties?: Record<string, unknown>;
  birthdayProperties?: Record<string, unknown>;
}

export interface Calendar {
  id: string;
  summary: string;
  description?: string;
  timeZone?: string;
  accessRole?: string;
  primary?: boolean;
}

export interface CalendarListResponse {
  items: Calendar[];
  nextPageToken?: string;
}

export interface EventsListResponse {
  items: CalendarEvent[];
  nextPageToken?: string;
}

export interface FreeBusyResponse {
  calendars: {
    [calendarId: string]: {
      busy: Array<{ start: string; end: string }>;
      errors?: Array<{ reason: string }>;
    };
  };
}

export const formattedDateTimeSchema = z.object({
  date: z.string().optional(),
  time: z.string().optional(),
  dayOfWeek: z.string().optional(),
  timezone: z.string().optional(),
}).passthrough();

export const calendarSchema = z.object({
  id: z.string().optional(),
  summary: z.string().optional(),
  description: z.string().optional(),
  timeZone: z.string().optional(),
  accessRole: z.string().optional(),
  primary: z.boolean().optional(),
}).passthrough();

export const attendeeSchema = z.object({
  email: z.string().optional(),
  responseStatus: z.string().nullable().optional(),
  displayName: z.string().optional(),
  optional: z.boolean().optional(),
  organizer: z.boolean().optional(),
  self: z.boolean().optional(),
  additionalGuests: z.number().optional(),
  resource: z.boolean().optional(),
}).passthrough();

export const personSchema = z.object({
  email: z.string().optional(),
  displayName: z.string().optional(),
}).passthrough();

export const conferenceEntryPointSchema = z.object({
  entryPointType: z.string().optional(),
  uri: z.string().optional(),
  label: z.string().optional(),
}).passthrough();

export const conferenceDataSchema = z.object({
  entryPoints: z.array(conferenceEntryPointSchema).optional(),
  conferenceSolution: z.object({
    name: z.string().optional(),
    iconUri: z.string().optional(),
  }).passthrough().optional(),
  conferenceId: z.string().optional(),
}).passthrough();

export const eventSchema = z.object({
  id: z.string().optional(),
  summary: z.string().optional(),
  start: formattedDateTimeSchema.optional(),
  end: formattedDateTimeSchema.optional(),
  recurrence: z.array(z.string()).optional(),
  recurringEventId: z.string().optional(),
  originalStartTime: formattedDateTimeSchema.optional(),
  location: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  attendees: z.array(attendeeSchema).optional(),
  attendeesOmitted: z.boolean().optional(),
  organizer: personSchema.optional(),
  creator: personSchema.optional(),
  colorId: z.string().optional(),
  visibility: z.string().optional(),
  availability: z.enum(['busy', 'free']).optional(),
  eventType: z.string().optional(),
  reminders: z.object({
    useDefault: z.boolean().optional(),
    overrides: z.array(z.object({ method: z.string(), minutes: z.number() }).passthrough()).optional(),
  }).passthrough().optional(),
  htmlLink: z.string().optional(),
  hangoutLink: z.string().optional(),
  conferenceData: conferenceDataSchema.optional(),
  status: z.string().optional(),
  created: z.string().optional(),
  updated: z.string().optional(),
  attachments: z.array(z.object({
    fileUrl: z.string(),
    title: z.string().optional(),
    mimeType: z.string().optional(),
    fileId: z.string().optional(),
  }).passthrough()).optional(),
  guestPermissions: z.object({
    canModify: z.boolean().optional(),
    canInviteOthers: z.boolean().optional(),
    canSeeOtherGuests: z.boolean().optional(),
  }).passthrough().optional(),
  outOfOffice: z.record(z.string(), z.unknown()).optional(),
  focusTime: z.record(z.string(), z.unknown()).optional(),
  workingLocation: z.record(z.string(), z.unknown()).optional(),
  birthday: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

function toGuestPermissions(event: CalendarEvent) {
  const out: Record<string, boolean> = {};
  if (typeof event.guestsCanModify === 'boolean') out.canModify = event.guestsCanModify;
  if (typeof event.guestsCanInviteOthers === 'boolean') out.canInviteOthers = event.guestsCanInviteOthers;
  if (typeof event.guestsCanSeeOtherGuests === 'boolean') out.canSeeOtherGuests = event.guestsCanSeeOtherGuests;
  return Object.keys(out).length > 0 ? out : undefined;
}

function toAttachments(attachments: EventAttachment[] | undefined) {
  if (!Array.isArray(attachments)) return undefined;
  const out = attachments
    .filter(a => a && typeof a.fileUrl === 'string')
    .map(a => ({
      fileUrl: a.fileUrl,
      ...(typeof a.title === 'string' && a.title && { title: a.title }),
      ...(typeof a.mimeType === 'string' && { mimeType: a.mimeType }),
      ...(typeof a.fileId === 'string' && { fileId: a.fileId }),
    }));
  return out.length > 0 ? out : undefined;
}

function toAttendee(a: EventAttendee) {
  if (typeof a.email !== 'string') return [];
  return [{
    email: a.email,
    responseStatus: a.responseStatus || null,
    ...(typeof a.displayName === 'string' && a.displayName && { displayName: a.displayName }),
    ...(a.optional === true && { optional: true }),
    ...(a.organizer === true && { organizer: true }),
    ...(a.self === true && { self: true }),
    ...(typeof a.additionalGuests === 'number' && a.additionalGuests > 0 && { additionalGuests: a.additionalGuests }),
    ...(a.resource === true && { resource: true }),
  }];
}

function toPerson(p: EventPerson | undefined) {
  if (!p || typeof p.email !== 'string') return undefined;
  return { email: p.email, ...(p.displayName && { displayName: p.displayName }) };
}

function sanitizeConferenceData(cd?: CalendarEvent['conferenceData']): ConferenceData | undefined {
  if (!cd) return undefined;
  const sanitized: ConferenceData = {};
  if (Array.isArray(cd.entryPoints)) {
    const entries = cd.entryPoints
      .filter(ep => ep && typeof ep.entryPointType === 'string' && typeof ep.uri === 'string')
      .map(ep => ({
        entryPointType: ep.entryPointType,
        uri: ep.uri,
        ...(ep.label && { label: ep.label }),
      }));
    if (entries.length > 0) sanitized.entryPoints = entries;
  }
  if (cd.conferenceSolution) {
    const sol: { name?: string; iconUri?: string } = {};
    if (typeof cd.conferenceSolution.name === 'string') sol.name = cd.conferenceSolution.name;
    if (typeof cd.conferenceSolution.iconUri === 'string') sol.iconUri = cd.conferenceSolution.iconUri;
    if (Object.keys(sol).length > 0) sanitized.conferenceSolution = sol;
  }
  if (typeof cd.conferenceId === 'string') sanitized.conferenceId = cd.conferenceId;
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

export function toStructuredEvent(event: CalendarEvent) {
  const sanitizedConf = sanitizeConferenceData(event.conferenceData);
  const attachments = toAttachments(event.attachments);
  const guestPermissions = toGuestPermissions(event);
  const organizer = toPerson(event.organizer);
  const creator = toPerson(event.creator);
  return {
    id: event.id,
    summary: event.summary || 'Untitled Event',
    start: formatDateTimeWithDay(event.start),
    end: formatDateTimeWithDay(event.end),
    location: event.location || null,
    description: event.description || null,
    attendees: (event.attendees ?? []).flatMap(toAttendee),
    ...(event.attendeesOmitted === true && { attendeesOmitted: true }),
    ...(organizer && { organizer }),
    ...(creator && { creator }),
    ...(typeof event.colorId === 'string' && { colorId: event.colorId }),
    ...(typeof event.visibility === 'string' && { visibility: event.visibility }),
    availability: event.transparency === 'transparent' ? ('free' as const) : ('busy' as const),
    ...(typeof event.eventType === 'string' && { eventType: event.eventType }),
    ...(event.reminders && { reminders: event.reminders }),
    ...(typeof event.status === 'string' && { status: event.status }),
    ...(typeof event.created === 'string' && { created: event.created }),
    ...(typeof event.updated === 'string' && { updated: event.updated }),
    ...(Array.isArray(event.recurrence) && event.recurrence.length > 0 && { recurrence: event.recurrence }),
    ...(typeof event.recurringEventId === 'string' && { recurringEventId: event.recurringEventId }),
    ...(event.originalStartTime && { originalStartTime: formatDateTimeWithDay(event.originalStartTime) }),
    ...(typeof event.htmlLink === 'string' && { htmlLink: event.htmlLink }),
    ...(typeof event.hangoutLink === 'string' && { hangoutLink: event.hangoutLink }),
    ...(sanitizedConf && { conferenceData: sanitizedConf }),
    ...(attachments && { attachments }),
    ...(guestPermissions && { guestPermissions }),
    ...(event.outOfOfficeProperties && { outOfOffice: event.outOfOfficeProperties }),
    ...(event.focusTimeProperties && { focusTime: event.focusTimeProperties }),
    ...(event.workingLocationProperties && { workingLocation: event.workingLocationProperties }),
    ...(event.birthdayProperties && { birthday: event.birthdayProperties }),
  };
}
