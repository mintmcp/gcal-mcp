import { z } from "zod";
import { withGoogleAuth as requirePermissionSecure } from "./auth.js";
import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
  breaks: true
});

// ---------- Shared Google API helpers ----------

const GOOGLE_FETCH_TIMEOUT_MS = 25_000;

type GoogleFetchResult =
  | {
      ok: true;
      status: number;
      headers: Headers;
      bodyText: string;
      bodyJson: unknown;
    }
  | {
      ok: false;
      kind: "http" | "network" | "timeout" | "parse";
      status: number; // 0 when no HTTP response was received
      statusText: string;
      headers?: Headers;
      bodyText: string;
      bodyJson?: unknown;
      retryAfterSeconds?: number;
      cause?: string;
    };

/**
 * Wraps fetch with an AbortController timeout and safe body parsing.
 * Never throws — returns a discriminated result the caller can pattern-match on.
 */
async function googleFetch(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = GOOGLE_FETCH_TIMEOUT_MS
): Promise<GoogleFetchResult> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: ac.signal });
  } catch (err: any) {
    clearTimeout(timer);
    const aborted = err?.name === "AbortError";
    return {
      ok: false,
      kind: aborted ? "timeout" : "network",
      status: 0,
      statusText: aborted ? "Request Timeout" : "Network Error",
      bodyText: "",
      cause: err?.message ? String(err.message) : String(err),
    };
  }
  clearTimeout(timer);

  // Read body once as text, then attempt JSON parse.
  let bodyText = "";
  try {
    bodyText = await response.text();
  } catch (err: any) {
    return {
      ok: false,
      kind: "parse",
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      bodyText: "",
      cause: err?.message ? String(err.message) : String(err),
    };
  }

  let bodyJson: unknown = undefined;
  if (bodyText.length > 0) {
    try {
      bodyJson = JSON.parse(bodyText);
    } catch {
      // Non-JSON body (e.g. HTML error page from an upstream proxy).
      bodyJson = undefined;
    }
  }

  if (!response.ok) {
    const retryAfterRaw = response.headers.get("Retry-After");
    let retryAfterSeconds: number | undefined;
    if (retryAfterRaw) {
      const n = Number(retryAfterRaw);
      if (Number.isFinite(n) && n >= 0) {
        retryAfterSeconds = Math.ceil(n);
      } else {
        // HTTP-date form — convert to seconds from now (clamped to >= 0).
        const t = Date.parse(retryAfterRaw);
        if (!Number.isNaN(t)) {
          retryAfterSeconds = Math.max(0, Math.ceil((t - Date.now()) / 1000));
        }
      }
    }
    return {
      ok: false,
      kind: "http",
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      bodyText,
      bodyJson,
      retryAfterSeconds,
    };
  }

  return {
    ok: true,
    status: response.status,
    headers: response.headers,
    bodyText,
    bodyJson,
  };
}

interface GoogleErrorContext {
  /** Human-readable name of the resource for 404 wording (e.g. "calendar", "event"). */
  resource?: string;
  /** Resource identifier to interpolate into the error message. */
  resourceId?: string;
  /** Operation verb for fallback messaging (e.g. "fetch calendars", "create event"). */
  operation: string;
}

/**
 * Maps a non-2xx GoogleFetchResult to a structured JSON error payload with
 * status-specific guidance. Returns an object suitable for `errorResult()`.
 */
function mapGoogleError(
  result: Extract<GoogleFetchResult, { ok: false }>,
  ctx: GoogleErrorContext
): Record<string, unknown> {
  // Try to extract Google's structured error message.
  let googleMessage: string | undefined;
  let googleReason: string | undefined;
  const body = result.bodyJson as any;
  if (body && typeof body === "object") {
    if (typeof body.error?.message === "string") {
      googleMessage = body.error.message;
    }
    if (Array.isArray(body.error?.errors) && body.error.errors.length > 0) {
      const first = body.error.errors[0];
      if (typeof first?.reason === "string") googleReason = first.reason;
    }
  }

  const base: Record<string, unknown> = {
    operation: ctx.operation,
    status: result.status,
    statusText: result.statusText,
  };
  if (ctx.resource) base.resource = ctx.resource;
  if (ctx.resourceId) base.resourceId = ctx.resourceId;
  if (googleMessage) base.googleMessage = googleMessage;
  if (googleReason) base.googleReason = googleReason;
  if (result.retryAfterSeconds !== undefined) {
    base.retryAfterSeconds = result.retryAfterSeconds;
  }

  if (result.kind === "timeout") {
    return {
      ...base,
      transient: true,
      error: `Timed out while trying to ${ctx.operation}. The Google Calendar API did not respond within ${GOOGLE_FETCH_TIMEOUT_MS / 1000}s. Retry once; if it persists, surface the issue to the user.`,
    };
  }
  if (result.kind === "network") {
    return {
      ...base,
      transient: true,
      error: `Network error while trying to ${ctx.operation}: ${result.cause || "unknown"}. Retry once before surfacing to the user.`,
    };
  }
  if (result.kind === "parse") {
    return {
      ...base,
      transient: true,
      error: `Could not read response body while trying to ${ctx.operation}: ${result.cause || "unknown"}.`,
    };
  }

  // HTTP error: status-specific guidance.
  const resLabel = ctx.resource && ctx.resourceId
    ? `${ctx.resource} "${ctx.resourceId}"`
    : ctx.resource || "resource";

  switch (result.status) {
    case 400:
      return {
        ...base,
        error: `Invalid request to ${ctx.operation}: ${googleMessage || result.bodyText || "Google rejected the request as malformed."} Check parameter formats (ISO 8601 datetimes, valid timezone identifiers, time ranges).`,
      };
    case 401:
      return {
        ...base,
        error: `Authentication failed while trying to ${ctx.operation}. The user's Google session is invalid or expired and they need to re-authenticate. Do NOT retry — surface this to the user.`,
      };
    case 403: {
      // Distinguish rate-limit 403 from permission 403.
      const isRateLimit =
        googleReason === "rateLimitExceeded" ||
        googleReason === "userRateLimitExceeded" ||
        googleReason === "quotaExceeded";
      if (isRateLimit) {
        return {
          ...base,
          transient: true,
          error: `Google Calendar rate limit hit while trying to ${ctx.operation}${result.retryAfterSeconds !== undefined ? ` (retry after ${result.retryAfterSeconds}s)` : ""}. Back off and try again.`,
        };
      }
      return {
        ...base,
        error: `Access denied for ${resLabel} while trying to ${ctx.operation}. The authenticated user does not have permission for this operation. Do NOT retry without changing input.`,
      };
    }
    case 404:
      return {
        ...base,
        error: `${resLabel} not found while trying to ${ctx.operation}. Verify the ID is correct (use list_calendars / get_calendar_events to look it up).`,
      };
    case 409:
      return {
        ...base,
        error: `Conflict while trying to ${ctx.operation}: ${googleMessage || "the resource may have been modified concurrently or the ID is already in use."}`,
      };
    case 410:
      return {
        ...base,
        error: `${resLabel} is gone (HTTP 410). It was likely already deleted. Do NOT retry.`,
      };
    case 429:
      return {
        ...base,
        transient: true,
        error: `Google Calendar rate limit hit (HTTP 429) while trying to ${ctx.operation}${result.retryAfterSeconds !== undefined ? `. Wait ${result.retryAfterSeconds}s before retrying.` : ". Back off and retry."}`,
      };
    case 500:
    case 502:
    case 503:
    case 504:
      return {
        ...base,
        transient: true,
        error: `Google Calendar is temporarily unavailable (HTTP ${result.status}) while trying to ${ctx.operation}${result.retryAfterSeconds !== undefined ? `. Wait ${result.retryAfterSeconds}s before retrying.` : ". Retry once after a short delay."}`,
      };
    default:
      return {
        ...base,
        error: `Unexpected HTTP ${result.status} (${result.statusText}) while trying to ${ctx.operation}: ${googleMessage || result.bodyText || "no error body"}.`,
      };
  }
}

/** Build a tool error result with a JSON-stringified body. */
function errorResult(payload: Record<string, unknown> | string) {
  const body = typeof payload === "string" ? { error: payload } : payload;
  return {
    content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }],
    isError: true as const,
  };
}

/** Build a tool success result with structured content. */
function okResult<T extends Record<string, unknown>>(structured: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
  };
}

interface ConferenceEntryPoint {
  entryPointType: string;
  uri: string;
  label?: string;
}

interface ConferenceData {
  entryPoints?: ConferenceEntryPoint[];
  conferenceSolution?: {
    name?: string;
    iconUri?: string;
  };
  conferenceId?: string;
}

interface CalendarEvent {
  id: string;
  summary: string;
  start: {
    dateTime?: string;
    date?: string;
  };
  end: {
    dateTime?: string;
    date?: string;
  };
  description?: string;
  location?: string;
  attendees?: Array<{
    email: string;
    responseStatus?: string;
  }>;
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
}

interface FormattedDateTime {
  date: string;
  time?: string;
  dayOfWeek: string;
  timezone?: string;
}

interface Calendar {
  id: string;
  summary: string;
  description?: string;
  timeZone?: string;
  accessRole?: string;
  primary?: boolean;
}

interface CalendarListResponse {
  items: Calendar[];
  nextPageToken?: string;
}

interface EventsListResponse {
  items: CalendarEvent[];
  nextPageToken?: string;
}

interface FreeBusyResponse {
  calendars: {
    [calendarId: string]: {
      busy: Array<{ start: string; end: string }>;
      errors?: Array<{ reason: string }>;
    };
  };
}

// Reusable output schema fragments.
// All schemas use .passthrough() + inner-optional fields so undocumented
// Google Calendar response fields don't trigger output validation errors.
const formattedDateTimeSchema = z.object({
  date: z.string().optional(),
  time: z.string().optional(),
  dayOfWeek: z.string().optional(),
  timezone: z.string().optional(),
}).passthrough();

const calendarSchema = z.object({
  id: z.string().optional(),
  summary: z.string().optional(),
  description: z.string().optional(),
  timeZone: z.string().optional(),
  accessRole: z.string().optional(),
  primary: z.boolean().optional(),
}).passthrough();

const attendeeSchema = z.object({
  email: z.string().optional(),
  responseStatus: z.string().nullable().optional(),
}).passthrough();

const conferenceEntryPointSchema = z.object({
  entryPointType: z.string().optional(),
  uri: z.string().optional(),
  label: z.string().optional(),
}).passthrough();

const conferenceDataSchema = z.object({
  entryPoints: z.array(conferenceEntryPointSchema).optional(),
  conferenceSolution: z.object({
    name: z.string().optional(),
    iconUri: z.string().optional(),
  }).passthrough().optional(),
  conferenceId: z.string().optional(),
}).passthrough();

const eventSchema = z.object({
  id: z.string().optional(),
  summary: z.string().optional(),
  start: formattedDateTimeSchema.optional(),
  end: formattedDateTimeSchema.optional(),
  location: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  attendees: z.array(attendeeSchema).optional(),
  htmlLink: z.string().optional(),
  hangoutLink: z.string().optional(),
  conferenceData: conferenceDataSchema.optional(),
  status: z.string().optional(),
  updated: z.string().optional(),
}).passthrough();

export class GoogleCalendarTools {
  private static getDayOfWeek(dateStr: string): string {
    const date = new Date(dateStr);
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return days[date.getDay()];
  }

  private static sanitizeConferenceData(cd?: CalendarEvent['conferenceData']): ConferenceData | undefined {
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

  private static formatDateTimeWithDay(eventDateTime: { dateTime?: string; date?: string }): FormattedDateTime {
    if (eventDateTime.dateTime) {
      // Parse ISO datetime string
      const dt = new Date(eventDateTime.dateTime);
      const dateStr = dt.toISOString().split('T')[0]; // YYYY-MM-DD
      
      // Extract time and timezone from the original string
      const timePart = eventDateTime.dateTime.split('T')[1];
      let time = '';
      let timezone = '';
      
      if (timePart) {
        // Handle timezone offset (e.g., -08:00 or Z)
        if (timePart.includes('+') || timePart.includes('-')) {
          const parts = timePart.split(/[+-]/);
          time = parts[0];
          timezone = timePart.substring(parts[0].length);
        } else if (timePart.includes('Z')) {
          time = timePart.replace('Z', '');
          timezone = 'Z';
        } else {
          time = timePart;
        }
      }
      
      return {
        date: dateStr,
        time: time,
        dayOfWeek: this.getDayOfWeek(eventDateTime.dateTime),
        timezone: timezone
      };
    } else if (eventDateTime.date) {
      // All-day event, only has date
      return {
        date: eventDateTime.date,
        dayOfWeek: this.getDayOfWeek(eventDateTime.date)
      };
    }
    
    // Fallback (shouldn't happen)
    return {
      date: '',
      dayOfWeek: ''
    };
  }

  static getTools() {
    return {
      list_calendars: {
        description: "List all calendars the user has access to. Use this to discover available calendars before performing calendar operations. The primary calendar (primary:true) is the user's main calendar. Other calendars may be shared, subscribed, or secondary calendars. The calendar ID is required for all other calendar operations.",
        readOnlyHint: true,
        outputSchema: {
          calendars: z.array(calendarSchema),
          nextPageToken: z.string().nullable(),
          message: z.string().optional(),
        },
        schema: {
          maxResults: z.coerce.number().int().optional().default(100).describe('Number of calendars to return (1-250). Default: 100'),
          pageToken: z.string().optional().describe('Pagination token from previous response to get next page'),
        },
        handler: requirePermissionSecure("https://www.googleapis.com/auth/calendar.readonly", async ({ maxResults, pageToken }: any, context: any) => {
          try {
            const googleToken = context.accessToken;
            const url = new URL('https://www.googleapis.com/calendar/v3/users/me/calendarList');
            url.searchParams.set('maxResults', Math.min(maxResults, 250).toString());
            if (pageToken) url.searchParams.set('pageToken', pageToken);

            const res = await googleFetch(url.toString(), {
              headers: {
                'Authorization': `Bearer ${googleToken}`,
                'Accept': 'application/json',
              },
            });
            if (!res.ok) {
              return errorResult(mapGoogleError(res, { operation: "list calendars" }));
            }

            const data = (res.bodyJson as CalendarListResponse) || { items: [] };
            const calendars = data.items || [];

            if (calendars.length === 0) {
              return okResult({
                calendars: [],
                nextPageToken: null,
                message: "No calendars found"
              });
            }

            return okResult({
              calendars: calendars.map(cal => ({
                id: cal.id,
                summary: cal.summary,
                description: cal.description,
                timeZone: cal.timeZone,
                accessRole: cal.accessRole,
                primary: cal.primary || false
              })),
              nextPageToken: data.nextPageToken || null
            });
          } catch (error: any) {
            return errorResult({ error: `Unexpected error in list_calendars: ${error?.message || String(error)}` });
          }
        })
      },

      get_calendar_events: {
        description: "Retrieve events from a specific calendar within a time range. Use this to view scheduled events, check availability, or find specific appointments. Times are interpreted in the provided timezone. Without dateMax, returns all future events from dateMin. IMPORTANT: For single day events, use next day as dateMax (e.g., dateMin='2024-01-15' and dateMax='2024-01-16'). Event IDs from this tool are required for update/delete operations.",
        readOnlyHint: true,
        outputSchema: {
          calendarId: z.string(),
          events: z.array(eventSchema),
          nextPageToken: z.string().nullable(),
          message: z.string().optional(),
        },
        schema: {
          calendarId: z.string().describe('Calendar ID from list_calendars (required - get ID first using list_calendars)'),
          maxResults: z.coerce.number().int().optional().default(10).describe('Number of events to return (1-2500). Default: 10'),
          dateMin: z.string().describe('Start date YYYY-MM-DD (e.g., "2024-01-15"). Required'),
          timeMin: z.string().describe('Start time HH:MM:SS (e.g., "09:00:00"). Required'),
          dateMax: z.string().optional().describe('End date YYYY-MM-DD. Events BEFORE this date. For single day, use next day'),
          timeMax: z.string().optional().describe('End time HH:MM:SS. Only valid with dateMax'),
          timeZone: z.string().describe('Timezone for interpreting dates/times (e.g., "America/Los_Angeles", "UTC")'),
          pageToken: z.string().optional().describe('Pagination token from previous response'),
        },
        handler: requirePermissionSecure("https://www.googleapis.com/auth/calendar.readonly", async ({ calendarId, maxResults, dateMin, timeMin, dateMax, timeMax, timeZone, pageToken }: any, context: any) => {
          try {
            const googleToken = context.accessToken;
            const encodedCalendarId = encodeURIComponent(calendarId);
            const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodedCalendarId}/events`);

            url.searchParams.set('maxResults', Math.min(maxResults, 2500).toString());
            url.searchParams.set('singleEvents', 'true');
            url.searchParams.set('orderBy', 'startTime');
            if (pageToken) url.searchParams.set('pageToken', pageToken);
            if (timeZone) url.searchParams.set('timeZone', timeZone);

            // Helper to get timezone offset using Intl API ("-08:00" / "+05:30" / "Z").
            const getOffset = (dateStr: string, timeStr: string, tz: string): string => {
              if (tz === 'UTC') return 'Z';
              const dateTime = new Date(`${dateStr}T${timeStr}`);
              const formatter = new Intl.DateTimeFormat('en-US', {
                timeZone: tz,
                timeZoneName: 'longOffset'
              });
              const parts = formatter.formatToParts(dateTime);
              const offsetPart = parts.find(p => p.type === 'timeZoneName')?.value || '';
              const offset = offsetPart.replace('GMT', '').trim();
              return offset || 'Z';
            };

            const minOffset = getOffset(dateMin, timeMin, timeZone);
            const processedTimeMin = `${dateMin}T${timeMin}${minOffset}`;
            url.searchParams.set('timeMin', processedTimeMin);

            if (dateMax) {
              const maxTime = timeMax || '00:00:00';
              const maxOffset = getOffset(dateMax, maxTime, timeZone);
              const processedTimeMax = `${dateMax}T${maxTime}${maxOffset}`;
              url.searchParams.set('timeMax', processedTimeMax);
            } else if (timeMax) {
              return errorResult({
                error: "timeMax requires dateMax to be specified",
                hint: "Pass both dateMax (YYYY-MM-DD) and optionally timeMax (HH:MM:SS), or pass neither."
              });
            }

            const res = await googleFetch(url.toString(), {
              headers: {
                'Authorization': `Bearer ${googleToken}`,
                'Accept': 'application/json',
              },
            });
            if (!res.ok) {
              return errorResult(mapGoogleError(res, {
                operation: "fetch calendar events",
                resource: "calendar",
                resourceId: calendarId,
              }));
            }

            const data = (res.bodyJson as EventsListResponse) || { items: [] };
            const events = data.items || [];

            if (events.length === 0) {
              return okResult({
                calendarId,
                events: [] as any[],
                nextPageToken: null,
                message: `No events found in calendar "${calendarId}"${dateMin || dateMax ? ' for the specified time range' : ''}`
              });
            }

            const structuredEvents = events.flatMap(event => {
              try {
                const sanitizedConf = GoogleCalendarTools.sanitizeConferenceData(event.conferenceData);
                return [{
                  id: event.id,
                  summary: event.summary || 'Untitled Event',
                  start: this.formatDateTimeWithDay(event.start),
                  end: this.formatDateTimeWithDay(event.end),
                  location: event.location || null,
                  description: event.description || null,
                  attendees: event.attendees
                    ? event.attendees
                        .filter(a => typeof a.email === 'string')
                        .map(a => ({ email: a.email, responseStatus: a.responseStatus || null }))
                    : [],
                  ...(typeof event.htmlLink === 'string' && { htmlLink: event.htmlLink }),
                  ...(typeof event.hangoutLink === 'string' && { hangoutLink: event.hangoutLink }),
                  ...(sanitizedConf && { conferenceData: sanitizedConf }),
                }];
              } catch {
                return [];
              }
            });

            return okResult({
              calendarId,
              events: structuredEvents,
              nextPageToken: data.nextPageToken || null
            });
          } catch (error: any) {
            return errorResult({ error: `Unexpected error in get_calendar_events: ${error?.message || String(error)}` });
          }
        })
      },

      create_event: {
        description: "Create a new calendar event. Use this to schedule meetings, appointments, or all-day events. For all-day events, only provide dates (end date is EXCLUSIVE - use '2024-01-16' for a single day event on Jan 15). For timed events, both start and end times are required. Can optionally invite attendees with email notifications. The created event ID can be used for future updates or deletion.",
        outputSchema: {
          id: z.string(),
          summary: z.string(),
          start: formattedDateTimeSchema,
          end: formattedDateTimeSchema,
          location: z.string().optional(),
          description: z.string().optional(),
          attendees: z.array(attendeeSchema).optional(),
          htmlLink: z.string().optional(),
          hangoutLink: z.string().optional(),
          conferenceData: conferenceDataSchema.optional(),
          status: z.string().optional(),
        },
        schema: {
          calendarId: z.string().describe('Calendar ID from list_calendars (required - get ID first using list_calendars)'),
          summary: z.string().describe('Event title'),
          description: z.string().optional().describe('Event description. Supports markdown formatting'),
          location: z.string().optional().describe('Event location (address or meeting room)'),
          startDate: z.string().describe('Start date YYYY-MM-DD (e.g., "2024-01-15")'),
          startTime: z.string().optional().describe('Start time HH:MM:SS (e.g., "14:00:00"). Omit for all-day events'),
          endDate: z.string().describe('End date YYYY-MM-DD. For all-day: next day. For timed: same or later day'),
          endTime: z.string().optional().describe('End time HH:MM:SS (e.g., "15:00:00"). Required if startTime provided'),
          timeZone: z.string().describe('Timezone (e.g., "America/Los_Angeles", "UTC", "Europe/London")'),
          attendees: z.array(z.string()).optional().describe('Email addresses of attendees to invite'),
          sendUpdates: z.enum(['all', 'externalOnly', 'none']).optional().default('all').describe('all: notify everyone, externalOnly: only external users, none: no notifications'),
        },
        handler: requirePermissionSecure("https://www.googleapis.com/auth/calendar.events", async (params: any, context: any) => {
          try {
            const googleToken = context.accessToken;
            const {
              calendarId, summary, description, location,
              startDate, startTime, endDate, endTime, timeZone, attendees, sendUpdates
            } = params;

            const event: any = {
              summary,
              description: description ? md.render(description) : undefined,
              location,
            };

            const isAllDay = !startTime && !endTime;

            if (isAllDay) {
              event.start = { date: startDate };
              event.end = { date: endDate };
            } else {
              if (!startTime || !endTime) {
                return errorResult({
                  error: "For timed events, both startTime and endTime must be provided.",
                  hint: "For all-day events, omit BOTH startTime and endTime. For timed events, provide BOTH."
                });
              }
              const startDateTime = `${startDate}T${startTime}`;
              const endDateTime = `${endDate}T${endTime}`;
              event.start = {
                dateTime: startDateTime,
                ...(timeZone && { timeZone })
              };
              event.end = {
                dateTime: endDateTime,
                ...(timeZone && { timeZone })
              };
            }

            if (attendees && attendees.length > 0) {
              event.attendees = attendees.map((email: string) => ({ email }));
            }

            const encodedCalendarId = encodeURIComponent(calendarId);
            const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodedCalendarId}/events`);
            url.searchParams.set('sendUpdates', sendUpdates);

            const res = await googleFetch(url.toString(), {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${googleToken}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
              },
              body: JSON.stringify(event),
            });
            if (!res.ok) {
              return errorResult(mapGoogleError(res, {
                operation: "create calendar event",
                resource: "calendar",
                resourceId: calendarId,
              }));
            }

            const createdEvent = (res.bodyJson as CalendarEvent) || ({} as CalendarEvent);
            if (!createdEvent.id) {
              return errorResult({
                error: "Google returned an unexpected response with no event id.",
                bodyText: res.bodyText,
              });
            }

            const sanitizedConf = GoogleCalendarTools.sanitizeConferenceData(createdEvent.conferenceData);
            return okResult({
              id: createdEvent.id,
              summary: createdEvent.summary,
              start: this.formatDateTimeWithDay(createdEvent.start),
              end: this.formatDateTimeWithDay(createdEvent.end),
              location: createdEvent.location,
              description: createdEvent.description,
              attendees: createdEvent.attendees,
              ...(typeof createdEvent.htmlLink === 'string' && { htmlLink: createdEvent.htmlLink }),
              ...(typeof createdEvent.hangoutLink === 'string' && { hangoutLink: createdEvent.hangoutLink }),
              ...(sanitizedConf && { conferenceData: sanitizedConf }),
              status: createdEvent.status,
            });
          } catch (error: any) {
            return errorResult({ error: `Unexpected error in create_event: ${error?.message || String(error)}` });
          }
        })
      },

      update_event: {
        description: "Update an existing event by eventId. Dates/times are interpreted in the provided timezone. Can update individual fields (summary, description, location) OR update times (must provide all: startDate, endDate, and optionally startTime, endTime). WARNING: Empty strings/arrays CLEAR fields. Cannot move between calendars. Returns updated event {id, summary, start, end, updated, ...}.",
        outputSchema: {
          id: z.string(),
          summary: z.string(),
          start: formattedDateTimeSchema,
          end: formattedDateTimeSchema,
          location: z.string().optional(),
          description: z.string().optional(),
          attendees: z.array(attendeeSchema).optional(),
          htmlLink: z.string().optional(),
          hangoutLink: z.string().optional(),
          conferenceData: conferenceDataSchema.optional(),
          status: z.string().optional(),
          updated: z.string().optional(),
        },
        schema: {
          calendarId: z.string().describe('Calendar ID from list_calendars'),
          eventId: z.string().describe('Event ID to update'),
          summary: z.string().optional().describe('Event title/summary'),
          description: z.string().optional().describe('Event description'),
          location: z.string().optional().describe('Event location'),
          startDate: z.string().optional().describe('Start date in YYYY-MM-DD format (e.g., "2024-01-15"). Required if updating time'),
          startTime: z.string().optional().describe('Start time in HH:MM:SS format (e.g., "14:00:00"). Omit for all-day events'),
          endDate: z.string().optional().describe('End date in YYYY-MM-DD format (e.g., "2024-01-16" for all-day or "2024-01-15" for timed). Required if updating time'),
          endTime: z.string().optional().describe('End time in HH:MM:SS format (e.g., "15:00:00"). Omit for all-day events'),
          timeZone: z.string().describe('Timezone for interpreting dates and times (e.g., "America/Los_Angeles", "UTC", "Europe/London")'),
          attendees: z.array(z.string()).optional().describe('Array of attendee email addresses (replaces existing attendees)'),
          sendUpdates: z.enum(['all', 'externalOnly', 'none']).optional().default('all').describe('Whether to send update notifications (all: notify all attendees, externalOnly: only non-Google Calendar users, none: no notifications)'),
        },
        handler: requirePermissionSecure("https://www.googleapis.com/auth/calendar.events", async (params: any, context: any) => {
          try {
            const googleToken = context.accessToken;
            const {
              calendarId, eventId, summary, description, location,
              startDate, startTime, endDate, endTime, timeZone, attendees, sendUpdates
            } = params;

            const updates: any = {};
            if (summary !== undefined) updates.summary = summary;
            if (description !== undefined) updates.description = md.render(description);
            if (location !== undefined) updates.location = location;

            const hasDateFields = startDate !== undefined || endDate !== undefined;
            const hasTimeFields = startTime !== undefined || endTime !== undefined;

            if (hasDateFields) {
              if (!startDate || !endDate) {
                return errorResult({
                  error: "When updating event dates, BOTH startDate and endDate must be provided.",
                  hint: "To leave the date unchanged, omit both startDate and endDate."
                });
              }
              const isAllDay = !startTime && !endTime;
              if (isAllDay) {
                updates.start = { date: startDate };
                updates.end = { date: endDate };
              } else {
                if (!startTime || !endTime) {
                  return errorResult({
                    error: "For timed events, both startTime and endTime must be provided.",
                    hint: "Provide BOTH startTime and endTime, or omit BOTH for an all-day event."
                  });
                }
                const startDateTime = `${startDate}T${startTime}`;
                const endDateTime = `${endDate}T${endTime}`;
                updates.start = {
                  dateTime: startDateTime,
                  ...(timeZone && { timeZone })
                };
                updates.end = {
                  dateTime: endDateTime,
                  ...(timeZone && { timeZone })
                };
              }
            } else if (hasTimeFields) {
              return errorResult({
                error: "Time fields cannot be updated without date fields.",
                hint: "Re-pass the event's existing date(s) along with the new startTime/endTime."
              });
            }

            if (attendees !== undefined) {
              updates.attendees = attendees.map((email: string) => ({ email }));
            }

            const encodedCalendarId = encodeURIComponent(calendarId);
            const encodedEventId = encodeURIComponent(eventId);
            const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodedCalendarId}/events/${encodedEventId}`);
            url.searchParams.set('sendUpdates', sendUpdates);

            const res = await googleFetch(url.toString(), {
              method: 'PATCH',
              headers: {
                'Authorization': `Bearer ${googleToken}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
              },
              body: JSON.stringify(updates),
            });
            if (!res.ok) {
              return errorResult(mapGoogleError(res, {
                operation: "update calendar event",
                resource: "event",
                resourceId: eventId,
              }));
            }

            const updatedEvent = (res.bodyJson as CalendarEvent) || ({} as CalendarEvent);
            if (!updatedEvent.id) {
              return errorResult({
                error: "Google returned an unexpected response with no event id.",
                bodyText: res.bodyText,
              });
            }

            const sanitizedConf = GoogleCalendarTools.sanitizeConferenceData(updatedEvent.conferenceData);
            return okResult({
              id: updatedEvent.id,
              summary: updatedEvent.summary,
              start: this.formatDateTimeWithDay(updatedEvent.start),
              end: this.formatDateTimeWithDay(updatedEvent.end),
              location: updatedEvent.location,
              description: updatedEvent.description,
              attendees: updatedEvent.attendees,
              ...(typeof updatedEvent.htmlLink === 'string' && { htmlLink: updatedEvent.htmlLink }),
              ...(typeof updatedEvent.hangoutLink === 'string' && { hangoutLink: updatedEvent.hangoutLink }),
              ...(sanitizedConf && { conferenceData: sanitizedConf }),
              status: updatedEvent.status,
              updated: updatedEvent.updated,
            });
          } catch (error: any) {
            return errorResult({ error: `Unexpected error in update_event: ${error?.message || String(error)}` });
          }
        })
      },

      delete_event: {
        description: "Permanently delete an event by eventId (no undo). Sends cancellation notifications to attendees by default (control with sendUpdates). Returns {success: true, eventId, message} on success.",
        destructiveHint: true,
        outputSchema: {
          success: z.boolean(),
          eventId: z.string(),
          message: z.string(),
        },
        schema: {
          calendarId: z.string().describe('Calendar ID from list_calendars'),
          eventId: z.string().describe('Event ID to delete'),
          sendUpdates: z.enum(['all', 'externalOnly', 'none']).optional().default('all').describe('Whether to send cancellation notifications (all: notify all attendees, externalOnly: only non-Google Calendar users, none: no notifications)'),
        },
        handler: requirePermissionSecure("https://www.googleapis.com/auth/calendar.events", async (params: any, context: any) => {
          try {
            const googleToken = context.accessToken;
            const { calendarId, eventId, sendUpdates } = params;

            const encodedCalendarId = encodeURIComponent(calendarId);
            const encodedEventId = encodeURIComponent(eventId);
            const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodedCalendarId}/events/${encodedEventId}`);
            url.searchParams.set('sendUpdates', sendUpdates);

            const res = await googleFetch(url.toString(), {
              method: 'DELETE',
              headers: {
                'Authorization': `Bearer ${googleToken}`,
                'Accept': 'application/json',
              },
            });
            if (!res.ok) {
              return errorResult(mapGoogleError(res, {
                operation: "delete calendar event",
                resource: "event",
                resourceId: eventId,
              }));
            }

            return okResult({
              success: true,
              eventId,
              message: `Event ${eventId} successfully deleted from calendar ${calendarId}`,
            });
          } catch (error: any) {
            return errorResult({ error: `Unexpected error in delete_event: ${error?.message || String(error)}` });
          }
        })
      },

      get_next_availability: {
        description: "Find next 10 available time slots in a calendar. Searches up to 30 days ahead. Returns {availableSlots: [{start, end}...], searchedUntil} with times in the specified timezone. Use searchedUntil with new startFromDate/Time to paginate. Can restrict to specific hours/days. Slots align to startTimeIncrement boundaries.",
        readOnlyHint: true,
        outputSchema: {
          availableSlots: z.array(z.object({
            start: formattedDateTimeSchema,
            end: formattedDateTimeSchema,
          })),
          searchedUntil: z.string(),
        },
        schema: {
          duration: z.coerce.number().int().describe('Duration of the meeting in minutes (e.g., 30, 60, 90)'),
          timezone: z.string().describe('Time zone for all operations (IANA format, e.g., "America/New_York")'),
          searchHoursStart: z.string().optional().describe('Daily search window start time in HH:MM:SS format (e.g., "09:00:00"). If not provided, searches all hours'),
          searchHoursEnd: z.string().optional().describe('Daily search window end time in HH:MM:SS format (e.g., "17:00:00"). If not provided, searches all hours'),
          includeDays: z.array(z.enum(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']))
            .optional()
            .default(['Mon', 'Tue', 'Wed', 'Thu', 'Fri'])
            .describe('Days of the week to include in search (default: weekdays only)'),
          startFromDate: z.string().describe('Start searching from this date in YYYY-MM-DD format (e.g., "2024-01-15")'),
          startFromTime: z.string().describe('Start searching from this time in HH:MM:SS format (e.g., "09:00:00")'),
          startTimeIncrement: z.coerce.number().int().optional().default(30).describe('Increment between possible start times in minutes (e.g., 15 for every 15 minutes, 30 for every half-hour)'),
          calendarId: z.string().describe('Calendar ID from list_calendars'),
        },
        handler: requirePermissionSecure("https://www.googleapis.com/auth/calendar.readonly", async (params: any, context: any) => {
          try {
            const googleToken = context.accessToken;
            const {
              duration,
              timezone,
              searchHoursStart,
              searchHoursEnd,
              includeDays,
              startFromDate,
              startFromTime,
              startTimeIncrement,
              calendarId
            } = params;

            const startDateTime = `${startFromDate}T${startFromTime}`;
            const searchStart = new Date(startDateTime);

            // We'll search up to 30 days ahead to find 10 available slots
            const maxSearchDays = 30;
            const searchEnd = new Date(searchStart);
            searchEnd.setDate(searchEnd.getDate() + maxSearchDays);

            const requestBody: any = {
              timeMin: searchStart.toISOString(),
              timeMax: searchEnd.toISOString(),
              timeZone: timezone,
              items: [{ id: calendarId }]
            };

            const url = 'https://www.googleapis.com/calendar/v3/freeBusy';
            const res = await googleFetch(url, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${googleToken}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
              },
              body: JSON.stringify(requestBody),
            });
            if (!res.ok) {
              return errorResult(mapGoogleError(res, {
                operation: "query free/busy for calendar",
                resource: "calendar",
                resourceId: calendarId,
              }));
            }

            const data = (res.bodyJson as FreeBusyResponse) || ({ calendars: {} } as FreeBusyResponse);

            const calendarData = data.calendars?.[calendarId];
            if (!calendarData) {
              return errorResult({
                operation: "query free/busy for calendar",
                resource: "calendar",
                resourceId: calendarId,
                error: `Calendar ID "${calendarId}" not present in free/busy response. Verify the ID via list_calendars.`,
              });
            }

            if (calendarData.errors && calendarData.errors.length > 0) {
              const e = calendarData.errors[0];
              return errorResult({
                operation: "query free/busy for calendar",
                resource: "calendar",
                resourceId: calendarId,
                googleReason: e.reason,
                error:
                  e.reason === 'notFound'
                    ? `Calendar "${calendarId}" not found. Verify via list_calendars.`
                    : e.reason === 'forbidden'
                      ? `Access denied for calendar "${calendarId}". The authenticated user cannot read its free/busy info.`
                      : `Free/busy lookup failed for calendar "${calendarId}": ${e.reason || 'unknown error'}.`,
              });
            }
            
            // Collect all busy times from the calendar
            const busyTimes: Array<{start: Date, end: Date}> = [];
            if (calendarData.busy) {
              for (const busyPeriod of calendarData.busy) {
                busyTimes.push({
                  start: new Date(busyPeriod.start),
                  end: new Date(busyPeriod.end)
                });
              }
            }

            // Sort busy times by start time
            busyTimes.sort((a, b) => a.start.getTime() - b.start.getTime());

            // Find available slots
            const availableSlots: Array<{ start: FormattedDateTime; end: FormattedDateTime }> = [];
            let currentTime = new Date(searchStart);
            let searchedUntil = searchStart;

            // Helper function to check if a time is within search hours
            const isWithinSearchHours = (date: Date, tz: string): boolean => {
              // If no search hours specified, all times are valid
              if (!searchHoursStart && !searchHoursEnd) return true;
              
              // Convert to timezone-specific time
              const formatter = new Intl.DateTimeFormat('en-US', {
                timeZone: tz,
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false,
                weekday: 'short'
              });
              
              const parts = formatter.formatToParts(date);
              const hour = parseInt(parts.find(p => p.type === 'hour')?.value || '0');
              const minute = parseInt(parts.find(p => p.type === 'minute')?.value || '0');
              const second = parseInt(parts.find(p => p.type === 'second')?.value || '0');
              const weekday = parts.find(p => p.type === 'weekday')?.value;
              
              // Check if this day is included
              if (includeDays && !includeDays.includes(weekday)) return false;
              
              // Convert current time to seconds since midnight
              const currentTimeInSeconds = hour * 3600 + minute * 60 + second;
              
              // Parse search hours
              let startSeconds = 0;
              let endSeconds = 24 * 3600; // Default to end of day
              
              if (searchHoursStart) {
                const [startH, startM, startS] = searchHoursStart.split(':').map(Number);
                startSeconds = startH * 3600 + startM * 60 + startS;
              }
              
              if (searchHoursEnd) {
                const [endH, endM, endS] = searchHoursEnd.split(':').map(Number);
                endSeconds = endH * 3600 + endM * 60 + endS;
              }
              
              // Check if within search hours
              return currentTimeInSeconds >= startSeconds && currentTimeInSeconds < endSeconds;
            };

            // Helper function to advance to next slot
            const advanceToNextSlot = (date: Date): Date => {
              const next = new Date(date);
              next.setMinutes(next.getMinutes() + startTimeIncrement);
              return next;
            };

            // Helper function to check if a time range overlaps with any busy period
            const isSlotBusy = (slotStart: Date, slotEnd: Date): boolean => {
              for (const busy of busyTimes) {
                // Check if slot overlaps with busy period
                if (slotStart < busy.end && slotEnd > busy.start) {
                  return true;
                }
              }
              return false;
            };

            // Helper function to format date as local ISO 8601 string
            const toLocalISO = (date: Date, tz: string): string => {
              // Get the date/time components in the target timezone
              const formatter = new Intl.DateTimeFormat('en-US', {
                timeZone: tz,
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false
              });
              
              const parts = formatter.formatToParts(date);
              const getValue = (type: string) => parts.find(p => p.type === type)?.value || '00';
              
              // Build ISO string without timezone indicator
              return `${getValue('year')}-${getValue('month')}-${getValue('day')}T${getValue('hour')}:${getValue('minute')}:${getValue('second')}`;
            };

            // Search for available slots
            while (availableSlots.length < 10 && currentTime < searchEnd) {
              // Align to next slot boundary
              const minutes = currentTime.getMinutes();
              const remainder = minutes % startTimeIncrement;
              if (remainder !== 0) {
                currentTime.setMinutes(minutes + (startTimeIncrement - remainder));
                currentTime.setSeconds(0);
                currentTime.setMilliseconds(0);
              }

              const slotStart = new Date(currentTime);
              const slotEnd = new Date(slotStart);
              slotEnd.setMinutes(slotEnd.getMinutes() + duration);

              // Check if slot is within search hours
              if (isWithinSearchHours(slotStart, timezone) && isWithinSearchHours(slotEnd, timezone)) {
                // Check if slot is available (not busy)
                if (!isSlotBusy(slotStart, slotEnd)) {
                  const startISO = toLocalISO(slotStart, timezone);
                  const endISO = toLocalISO(slotEnd, timezone);
                  
                  // Parse the ISO strings to extract date and time
                  const startDate = startISO.split('T')[0];
                  const startTime = startISO.split('T')[1];
                  const endDate = endISO.split('T')[0];
                  const endTime = endISO.split('T')[1];
                  
                  availableSlots.push({
                    start: {
                      date: startDate,
                      time: startTime,
                      dayOfWeek: this.getDayOfWeek(startISO)
                    },
                    end: {
                      date: endDate,
                      time: endTime,
                      dayOfWeek: this.getDayOfWeek(endISO)
                    }
                  });
                  searchedUntil = slotEnd;
                }
              }

              // Move to next slot
              currentTime = advanceToNextSlot(currentTime);
            }

            // Update searchedUntil to be the last time we checked
            if (currentTime > searchedUntil) {
              searchedUntil = currentTime;
            }

            return okResult({
              availableSlots,
              searchedUntil: toLocalISO(searchedUntil, timezone)
            });
          } catch (error: any) {
            return errorResult({ error: `Unexpected error in get_next_availability: ${error?.message || String(error)}` });
          }
        })
      }
    };
  }
}