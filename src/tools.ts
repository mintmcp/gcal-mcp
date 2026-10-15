import { z } from "zod";
import { withGoogleAuth as requirePermissionSecure } from "./auth.js";
import MarkdownIt from 'markdown-it';
import {
  parseIso,
  attachOffsetForTimezone,
  getDayOfWeek,
  formatDateTimeWithDay,
  normalizeAttendees,
  isWithinSearchHours,
  alignToSlotBoundary,
  advanceToNextSlot,
  isSlotBusy,
  toLocalISO,
  type FormattedDateTime,
  type ParsedIso,
} from "./lib/datetime.js";
import { buildEventOptions, mergeAttendees, type EventOptions } from "./lib/event-fields.js";
import {
  sanitizeConferenceData,
  toStructuredEvent,
  calendarSchema,
  eventSchema,
  formattedDateTimeSchema,
  attendeeSchema,
  conferenceDataSchema,
  type EventAttendee,
  type CalendarEvent,
  type CalendarListResponse,
  type EventsListResponse,
  type FreeBusyResponse,
} from "./lib/event-model.js";

// `html: false` is intentional: descriptions come from LLM-generated text that
// may inadvertently contain raw HTML/script tags. Disabling pass-through still
// lets us emit the limited HTML (links, lists, emphasis, code) that Google
// Calendar's web UI actually renders.
const md = new MarkdownIt({
  html: false,
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


export type CallerAttendeeMatch =
  | { kind: 'found'; attendee: EventAttendee }
  | { kind: 'notFound' }
  | { kind: 'unverifiableCalendar' };

export function describeAttendeeRoster(attendees: EventAttendee[], sampleSize = 3): string {
  const emails = attendees.map(a => a.email).filter(e => typeof e === 'string');
  const sample = emails.slice(0, sampleSize).join(', ');
  const rest = emails.length - sampleSize;
  return `${attendees.length} attendee(s)${sample ? `, e.g. ${sample}${rest > 0 ? ` and ${rest} more` : ''}` : ''}`;
}

export function truncateBody(body: string | undefined, maxLength = 300): string {
  const text = String(body ?? '').replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

export function identifyCallerAttendee(
  attendees: EventAttendee[],
  callerEmail: string | undefined,
  calendarId: string,
): CallerAttendeeMatch {
  const target = callerEmail ? callerEmail.toLowerCase() : undefined;
  const byEmail = target
    ? attendees.find(a => typeof a.email === 'string' && a.email.toLowerCase() === target)
    : undefined;

  const ownCalendar = calendarId === 'primary' || (target !== undefined && calendarId.toLowerCase() === target);
  if (ownCalendar) {
    const match = byEmail || attendees.find(a => a.self === true);
    return match ? { kind: 'found', attendee: match } : { kind: 'notFound' };
  }

  if (!target) return { kind: 'unverifiableCalendar' };
  return byEmail ? { kind: 'found', attendee: byEmail } : { kind: 'notFound' };
}

async function resolveCallerEmailFromPrimaryCalendar(googleToken: string): Promise<string | undefined> {
  const res = await googleFetch("https://www.googleapis.com/calendar/v3/calendars/primary", {
    headers: {
      'Authorization': `Bearer ${googleToken}`,
      'Accept': 'application/json',
    },
  });
  if (!res.ok) return undefined;
  const id = (res.bodyJson as { id?: unknown } | undefined)?.id;
  return typeof id === 'string' && id.length > 0 ? id.toLowerCase() : undefined;
}

type ToolError = ReturnType<typeof errorResult>;

async function fetchEvent(
  googleToken: string,
  calendarId: string,
  eventId: string,
  operation: string,
): Promise<CalendarEvent | ToolError> {
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;
  const res = await googleFetch(url, {
    headers: {
      'Authorization': `Bearer ${googleToken}`,
      'Accept': 'application/json',
    },
  });
  if (!res.ok) {
    return errorResult(mapGoogleError(res, { operation, resource: "event", resourceId: eventId }));
  }
  const event = (res.bodyJson as CalendarEvent) || ({} as CalendarEvent);
  if (!event.id) {
    return errorResult({
      error: "Google returned an unexpected response with no event id.",
      bodyText: truncateBody(res.bodyText),
    });
  }
  return event;
}

/**
 * The calendar's own time zone, used to interpret naive date/time inputs when
 * the caller did not name one. A lookup failure is returned as a tool error
 * rather than guessed as UTC, because the zone decides the event instant
 */
async function fetchCalendarTimeZone(googleToken: string, calendarId: string): Promise<string | ToolError> {
  const res = await googleFetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}`, {
    headers: {
      'Authorization': `Bearer ${googleToken}`,
      'Accept': 'application/json',
    },
  });
  if (!res.ok) {
    return errorResult(mapGoogleError(res, {
      operation: "read the calendar time zone (pass `timeZone` explicitly to skip this lookup)",
      resource: "calendar",
      resourceId: calendarId,
    }));
  }
  const tz = (res.bodyJson as { timeZone?: unknown } | undefined)?.timeZone;
  return typeof tz === 'string' && tz.length > 0 ? tz : "UTC";
}

/**
 * Build the Google `start`/`end` payload for a pair of parsed ISO inputs of
 * the same kind. Naive datetimes get the explicit time zone, else the
 * calendar's own, so "10:00" means 10:00 on the user's calendar. Google also
 * demands a named zone on recurring timed events, offsets are not enough
 */
async function buildEventTimes(
  googleToken: string,
  calendarId: string,
  start: ParsedIso,
  end: ParsedIso,
  explicitTimeZone: string | undefined,
  recurring: boolean,
): Promise<{ start: Record<string, string>; end: Record<string, string> } | ToolError> {
  if (start.kind === "date" && end.kind === "date") {
    return { start: { date: start.date }, end: { date: end.date } };
  }
  if (start.kind !== "datetime" || end.kind !== "datetime") {
    throw new Error("`start` and `end` must be the same kind");
  }
  const needsZone = recurring || !start.hasOffset || !end.hasOffset;
  const timeZone = explicitTimeZone ?? (needsZone ? await fetchCalendarTimeZone(googleToken, calendarId) : undefined);
  if (timeZone !== undefined && typeof timeZone !== 'string') return timeZone;
  return {
    start: { dateTime: start.rfc3339, ...(timeZone && { timeZone }) },
    end: { dateTime: end.rfc3339, ...(timeZone && { timeZone }) },
  };
}


// Reusable INPUT schema fragments.
// Attendees may be supplied either as a bare email string ("alice@example.com")
// or as an object granting access to richer Calendar fields. `optional` marks
// the attendee as non-essential (Google Calendar shows a "(Optional)" tag).
const attendeeInputSchema = z.union([
  z.string(),
  z.object({
    email: z.string(),
    displayName: z.string().optional(),
    optional: z.boolean().optional(),
  }),
]);

const inputTimeZoneSchema = z
  .string()
  .optional()
  .describe('IANA timezone (e.g. "America/Los_Angeles") used to interpret naive datetimes. Defaults to the calendar\'s own time zone.');

// Optional event fields accepted by both create_event and update_event
const eventOptionsInputSchema = {
  recurrence: z
    .array(z.string())
    .optional()
    .describe('Recurrence rules as RFC 5545 strings, e.g. ["RRULE:FREQ=WEEKLY;BYDAY=MO,WE"] (RRULE, RDATE, EXDATE). Makes the event a recurring series. On update, pass [] to stop the series from repeating.'),
  colorId: z
    .string()
    .optional()
    .describe('Event colour ID "1"-"11" (1 lavender, 2 sage, 3 grape, 4 flamingo, 5 banana, 6 tangerine, 7 peacock, 8 graphite, 9 blueberry, 10 basil, 11 tomato).'),
  visibility: z
    .enum(['default', 'public', 'private', 'confidential'])
    .optional()
    .describe('Who can see event details: default (calendar setting), public, or private (attendees only).'),
  availability: z
    .enum(['busy', 'free'])
    .optional()
    .describe('Whether the event blocks time: busy (default) or free (shows as available).'),
  reminders: z
    .object({
      useDefault: z.boolean().optional().describe('true: use the calendar default reminders. false with no overrides: no reminders at all.'),
      overrides: z
        .array(z.object({ method: z.enum(['email', 'popup']), minutes: z.coerce.number().int().min(0) }))
        .optional()
        .describe('Custom reminders, each {method: email|popup, minutes before start}. Replaces the calendar defaults.'),
    })
    .optional()
    .describe('Reminder settings. Omit to keep the calendar defaults (or, on update, the existing reminders).'),
  addGoogleMeet: z
    .boolean()
    .optional()
    .describe('true: ask Google to create a Google Meet link for the event. The link is returned as `hangoutLink` / `conferenceData`.'),
};


export class GoogleCalendarTools {

  static getTools() {
    return {
      list_calendars: {
        description:
          "List all Google Calendars the authenticated user has access to (primary, shared, subscribed, secondary). " +
          "Use this when the user names a calendar (e.g. \"my work calendar\", \"team calendar\") and you need its ID — but for the user's MAIN calendar you do NOT need to call this first: pass calendarId='primary' to the other tools. " +
          "Returns up to `maxResults` items; if `nextPageToken` is returned, paginate by passing it back as `pageToken`.",
        readOnlyHint: true,
        outputSchema: {
          calendars: z.array(calendarSchema),
          nextPageToken: z.string().nullable(),
          message: z.string().optional(),
        },
        schema: {
          maxResults: z.coerce.number().int().positive().optional().default(100).describe('Calendars to return per page (1-250, clamped). Default: 100.'),
          pageToken: z.string().optional().describe('Pagination token from a prior call\'s `nextPageToken`.'),
        },
        handler: requirePermissionSecure("https://www.googleapis.com/auth/calendar.readonly", async ({ maxResults, pageToken }: any, context: any) => {
          try {
            const googleToken = context.accessToken;
            const url = new URL('https://www.googleapis.com/calendar/v3/users/me/calendarList');
            url.searchParams.set('maxResults', Math.min(Math.max(1, maxResults), 250).toString());
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
        description:
          "List events from a Google Calendar within a time range. Use this to read what's on a user's calendar — meetings, appointments, all-day events — for any date or range. " +
          "Defaults to the user's primary calendar starting NOW; call list_calendars first only when you need a non-primary calendar's ID. " +
          "Time inputs accept full ISO 8601 strings: 'YYYY-MM-DD' (treated as start of that day in `timeZone`), naive 'YYYY-MM-DDTHH:MM[:SS]' (combined with `timeZone`), or zone-aware '...Z' / '...±HH:MM'. " +
          "Without `timeMax`, returns the next `maxResults` events from `timeMin` onwards. " +
          "For a single calendar day, set `timeMin='2024-01-15'` and `timeMax='2024-01-16'` (end is EXCLUSIVE). " +
          "Pass `q` to search by keyword (matches title, description, location, attendee names/emails); with `q` and no `timeMin`, the WHOLE calendar is searched, past included. " +
          "Response times are formatted in `timeZone` when given, otherwise in the calendar's own time zone. " +
          "If `nextPageToken` is returned, more events match — pass it back as `pageToken` together with the SAME `q`, time bounds and calendarId to continue. " +
          "Recurring events are returned as expanded instances; each `id` (which may contain a date suffix) targets that single occurrence in update_event/delete_event. " +
          "Event `id`s in the response are required for update_event / delete_event.",
        readOnlyHint: true,
        outputSchema: {
          calendarId: z.string(),
          events: z.array(eventSchema),
          nextPageToken: z.string().nullable(),
          message: z.string().optional(),
        },
        schema: {
          calendarId: z
            .string()
            .optional()
            .default("primary")
            .describe('Calendar ID. Defaults to "primary" (the user\'s main calendar). Use list_calendars to discover other calendar IDs.'),
          maxResults: z.coerce.number().int().optional().default(10).describe('Number of events to return (1-2500). Default: 10. Google may return slightly fewer; check `nextPageToken`.'),
          timeMin: z
            .string()
            .optional()
            .describe(
              'Lower time bound (inclusive) as ISO 8601: "YYYY-MM-DD", "YYYY-MM-DDTHH:MM[:SS]", or "...Z"/"...±HH:MM". Defaults to NOW. Naive forms are interpreted in `timeZone`.'
            ),
          timeMax: z
            .string()
            .optional()
            .describe(
              'Upper time bound (EXCLUSIVE) as ISO 8601 — same formats as `timeMin`. Omit to retrieve future events from `timeMin`.'
            ),
          timeZone: z
            .string()
            .optional()
            .describe('IANA timezone (e.g. "America/Los_Angeles") used to interpret naive/date-only inputs and to format response times. Defaults to the calendar\'s own time zone.'),
          q: z
            .string()
            .optional()
            .describe('Free-text search. Case-insensitive; matches title, description, location and attendee names/emails. Without `timeMin`, searches the whole calendar including the past.'),
          pageToken: z.string().optional().describe('Pagination token from a prior call\'s `nextPageToken`. Pass it back to fetch the next page.'),
        },
        handler: requirePermissionSecure("https://www.googleapis.com/auth/calendar.readonly", async ({ calendarId, maxResults, timeMin, timeMax, timeZone, q, pageToken }: any, context: any) => {
          try {
            const googleToken = context.accessToken;
            const encodedCalendarId = encodeURIComponent(calendarId);
            const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodedCalendarId}/events`);

            url.searchParams.set('maxResults', Math.min(Math.max(1, maxResults), 2500).toString());
            url.searchParams.set('singleEvents', 'true');
            url.searchParams.set('orderBy', 'startTime');
            if (pageToken) url.searchParams.set('pageToken', pageToken);
            if (timeZone) url.searchParams.set('timeZone', timeZone);
            if (q) url.searchParams.set('q', q);

            const parsedMin = timeMin ? parseIso(timeMin) : null;
            if (timeMin && !parsedMin) {
              return errorResult({
                error: `Invalid timeMin "${timeMin}". Expected ISO 8601: YYYY-MM-DD, YYYY-MM-DDTHH:MM[:SS], or with Z/offset.`,
              });
            }
            const parsedMax = timeMax ? parseIso(timeMax) : null;
            if (timeMax && !parsedMax) {
              return errorResult({
                error: `Invalid timeMax "${timeMax}". Expected ISO 8601: YYYY-MM-DD, YYYY-MM-DDTHH:MM[:SS], or with Z/offset.`,
              });
            }

            const isNaive = (p: ReturnType<typeof parseIso>) => p !== null && (p.kind === "date" || !p.hasOffset);
            const tz = timeZone ?? (isNaive(parsedMin) || isNaive(parsedMax) ? await fetchCalendarTimeZone(googleToken, calendarId) : "UTC");
            if (typeof tz !== 'string') return tz;
            const toRfc3339 = (p: NonNullable<ReturnType<typeof parseIso>>) =>
              p.kind === "date"
                ? attachOffsetForTimezone(`${p.date}T00:00:00`, tz)
                : p.hasOffset ? p.rfc3339 : attachOffsetForTimezone(p.rfc3339, tz);

            // A keyword search with no lower bound covers the whole calendar;
            // otherwise the default lower bound is now
            if (parsedMin) {
              url.searchParams.set('timeMin', toRfc3339(parsedMin));
            } else if (!q) {
              url.searchParams.set('timeMin', new Date().toISOString());
            }
            if (parsedMax) url.searchParams.set('timeMax', toRfc3339(parsedMax));

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
                message: `No events found in calendar "${calendarId}" for the specified time range`
              });
            }

            const structuredEvents = events.flatMap(event => {
              try {
                return [toStructuredEvent(event)];
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

      get_event: {
        description:
          "Fetch a SINGLE Google Calendar event by its `eventId` — use this when you already have an event's ID (from get_calendar_events, create_event, or a Google Calendar link) and want its full, current details. " +
          "Prefer this over get_calendar_events when you know the exact event: it is a direct lookup, not a time-range scan. " +
          "Defaults to the user's primary calendar; pass `calendarId` (from list_calendars) for a non-primary calendar. " +
          "For a recurring event, pass the series `eventId` to read the series master, or a single instance ID ('<eventId>_<UTC timestamp>', e.g. 'abc123_20240115T170000Z') to read that one occurrence. " +
          "Returns the event {id, summary, start, end, location, description, attendees, ...}. Its `id` is the same value required by update_event / delete_event. " +
          "Recurring events are distinguishable: a SERIES MASTER carries `recurrence` (RRULE strings describing the repeat pattern); a single INSTANCE carries `recurringEventId` (the series `id`, to navigate back to the master) and `originalStartTime` (its scheduled slot — if it differs from `start`, the occurrence was moved).",
        readOnlyHint: true,
        outputSchema: {
          calendarId: z.string(),
          event: eventSchema,
        },
        schema: {
          calendarId: z
            .string()
            .optional()
            .default("primary")
            .describe('Calendar containing the event. Defaults to "primary". Use list_calendars to discover other calendar IDs.'),
          eventId: z.string().describe('Event ID to fetch (from get_calendar_events, create_event, or a calendar link).'),
          timeZone: z
            .string()
            .optional()
            .describe('IANA timezone (e.g. "America/Los_Angeles") used to format the returned event times. Defaults to the calendar\'s own time zone.'),
        },
        handler: requirePermissionSecure("https://www.googleapis.com/auth/calendar.readonly", async ({ calendarId, eventId, timeZone }: any, context: any) => {
          try {
            const googleToken = context.accessToken;
            const encodedCalendarId = encodeURIComponent(calendarId);
            const encodedEventId = encodeURIComponent(eventId);
            const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodedCalendarId}/events/${encodedEventId}`);
            if (timeZone) url.searchParams.set('timeZone', timeZone);

            const res = await googleFetch(url.toString(), {
              headers: {
                'Authorization': `Bearer ${googleToken}`,
                'Accept': 'application/json',
              },
            });
            if (!res.ok) {
              return errorResult(mapGoogleError(res, {
                operation: "fetch calendar event",
                resource: "event",
                resourceId: eventId,
              }));
            }

            const event = (res.bodyJson as CalendarEvent) || ({} as CalendarEvent);
            if (!event.id) {
              return errorResult({
                error: "Google returned an unexpected response with no event id.",
                bodyText: truncateBody(res.bodyText),
              });
            }

            return okResult({
              calendarId,
              event: toStructuredEvent(event),
            });
          } catch (error: any) {
            return errorResult({ error: `Unexpected error in get_event: ${error?.message || String(error)}` });
          }
        })
      },

      create_event: {
        description:
          "Create a new calendar event (meeting, appointment, or all-day block). " +
          "Pass `start` and `end` as ISO 8601 strings: use a date-only form ('YYYY-MM-DD') for an ALL-DAY event (end is EXCLUSIVE — use the day after the last day), or a datetime ('YYYY-MM-DDTHH:MM[:SS]' with optional 'Z'/'±HH:MM' offset) for a TIMED event. " +
          "Both `start` and `end` must be the same kind. Naive datetimes are interpreted in `timeZone`. " +
          "`description` is rendered through Markdown to HTML by the server. " +
          "When `attendees` are provided, Google sends invitations according to `sendUpdates` (default 'all'). " +
          "Optional extras: `recurrence` (RRULE strings) for a repeating series, `addGoogleMeet` for a Meet link, `colorId`, `visibility`, `availability` (busy/free) and `reminders`. " +
          "Returns the created event including `id` which is required for update_event / delete_event.",
        outputSchema: eventSchema.shape,
        schema: {
          calendarId: z
            .string()
            .optional()
            .default("primary")
            .describe('Calendar ID. Defaults to "primary". Use list_calendars to discover other calendar IDs.'),
          summary: z.string().describe('Event title (required).'),
          description: z.string().optional().describe('Event description. Rendered as Markdown to HTML by the server.'),
          location: z.string().optional().describe('Event location (address, meeting room, etc.).'),
          start: z
            .string()
            .describe(
              'Start as ISO 8601. Date-only ("2024-01-15") creates an all-day event. Datetime ("2024-01-15T14:00:00" or "2024-01-15T14:00:00-08:00") creates a timed event. Naive datetimes are interpreted in `timeZone`.'
            ),
          end: z
            .string()
            .describe(
              'End as ISO 8601, same kind as `start`. For all-day, end date is EXCLUSIVE (use the next day for a single-day event). For timed, must be after `start`.'
            ),
          timeZone: inputTimeZoneSchema,
          attendees: z.array(attendeeInputSchema).optional().describe('Attendees to invite. Each item may be a bare email string ("alice@example.com") or an object {email, displayName?, optional?}. Set optional=true to mark an attendee as non-essential.'),
          sendUpdates: z
            .enum(['all', 'externalOnly', 'none'])
            .optional()
            .default('all')
            .describe('Invitation behaviour. all: notify everyone, externalOnly: only non-Google-Calendar users, none: no notifications.'),
          ...eventOptionsInputSchema,
        },
        handler: requirePermissionSecure("https://www.googleapis.com/auth/calendar.events", async (params: any, context: any) => {
          try {
            const googleToken = context.accessToken;
            const {
              calendarId, summary, description, location,
              start, end, attendees, sendUpdates
            } = params;

            const parsedStart = parseIso(start);
            const parsedEnd = parseIso(end);
            if (!parsedStart) {
              return errorResult({ error: `Invalid \`start\` "${start}". Expected ISO 8601 (date or datetime).` });
            }
            if (!parsedEnd) {
              return errorResult({ error: `Invalid \`end\` "${end}". Expected ISO 8601 (date or datetime).` });
            }
            if (parsedStart.kind !== parsedEnd.kind) {
              return errorResult({
                error: "`start` and `end` must be the same kind (both date-only for all-day, or both datetime for timed).",
              });
            }

            const event: any = {
              summary,
              description: description ? md.render(description) : undefined,
              location,
              ...buildEventOptions(params as EventOptions),
            };

            const times = await buildEventTimes(
              googleToken, calendarId, parsedStart, parsedEnd, params.timeZone, (params.recurrence?.length ?? 0) > 0,
            );
            if ('isError' in times) return times;
            Object.assign(event, times);

            const normalizedAttendees = normalizeAttendees(attendees);
            if (normalizedAttendees && normalizedAttendees.length > 0) {
              event.attendees = normalizedAttendees;
            }

            const encodedCalendarId = encodeURIComponent(calendarId);
            const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodedCalendarId}/events`);
            url.searchParams.set('sendUpdates', sendUpdates);
            if (event.conferenceData) url.searchParams.set('conferenceDataVersion', '1');

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

            return okResult(toStructuredEvent(createdEvent));
          } catch (error: any) {
            return errorResult({ error: `Unexpected error in create_event: ${error?.message || String(error)}` });
          }
        })
      },

      update_event: {
        description:
          "Patch fields on an existing Google Calendar event by `eventId`. " +
          "Omit a field to leave it unchanged. Pass an empty string for `location` (or empty array for `attendees`) to CLEAR that field. " +
          "To reschedule, pass BOTH `start` and `end` as ISO 8601 — both date-only (all-day) or both datetime (timed). Pass neither to leave the schedule unchanged. " +
          "`description` is rendered through Markdown to HTML by the server. " +
          "To add or remove guests, use `addAttendees` / `removeAttendees`: everyone else keeps their current response. " +
          "ATTENDEES WARNING: `attendees` REPLACES the entire attendee list and resets every responseStatus to needsAction; whether notifications are re-sent depends on `sendUpdates`. To accept/decline/tentatively respond for YOURSELF, use respond_to_event instead — it preserves everyone else's responses. " +
          "Optional extras: `recurrence`, `addGoogleMeet`, `colorId`, `visibility`, `availability` (busy/free) and `reminders`. " +
          "Cannot move an event between calendars. For a recurring-instance `eventId` (date-suffixed), the patch applies to that single occurrence only. Returns the updated event including a fresh `updated` timestamp.",
        outputSchema: eventSchema.shape,
        schema: {
          calendarId: z
            .string()
            .optional()
            .default("primary")
            .describe('Calendar containing the event. Defaults to "primary".'),
          eventId: z.string().describe('Event ID (from get_calendar_events or create_event).'),
          summary: z.string().optional().describe('New event title.'),
          description: z.string().optional().describe('New description. Rendered as Markdown to HTML server-side. Pass an empty string to clear.'),
          location: z.string().optional().describe('New location. Pass an empty string to clear.'),
          start: z
            .string()
            .optional()
            .describe(
              'New start as ISO 8601 — date-only for all-day, datetime for timed. Must be paired with `end` of the same kind. Omit to leave the schedule unchanged.'
            ),
          end: z
            .string()
            .optional()
            .describe(
              'New end as ISO 8601, same kind as `start`. Required if `start` is provided.'
            ),
          timeZone: inputTimeZoneSchema,
          attendees: z
            .array(attendeeInputSchema)
            .optional()
            .describe('REPLACES the entire attendee list with the given items (each a bare email or {email, displayName?, optional?}). Include existing attendees you want to keep. Pass [] to remove all. Prefer addAttendees / removeAttendees for incremental changes.'),
          addAttendees: z
            .array(attendeeInputSchema)
            .optional()
            .describe('Attendees to ADD (bare email or {email, displayName?, optional?}). Existing attendees and their responses are kept. Cannot be combined with `attendees`.'),
          removeAttendees: z
            .array(z.string())
            .optional()
            .describe('Email addresses of attendees to REMOVE. Everyone else keeps their response. Cannot be combined with `attendees`.'),
          sendUpdates: z
            .enum(['all', 'externalOnly', 'none'])
            .optional()
            .default('all')
            .describe('Notification behaviour. all / externalOnly / none.'),
          ...eventOptionsInputSchema,
        },
        handler: requirePermissionSecure("https://www.googleapis.com/auth/calendar.events", async (params: any, context: any) => {
          try {
            const googleToken = context.accessToken;
            const {
              calendarId, eventId, summary, description, location,
              start, end, attendees, addAttendees, removeAttendees, sendUpdates
            } = params;

            const updates: any = buildEventOptions(params as EventOptions);
            if (summary !== undefined) updates.summary = summary;
            if (description !== undefined) updates.description = md.render(description);
            if (location !== undefined) updates.location = location;

            const incremental = addAttendees !== undefined || removeAttendees !== undefined;
            if (incremental && attendees !== undefined) {
              return errorResult({
                error: "Pass either `attendees` (full replacement) or `addAttendees` / `removeAttendees` (incremental), not both.",
              });
            }

            const hasStart = start !== undefined;
            const hasEnd = end !== undefined;

            if (hasStart !== hasEnd) {
              return errorResult({
                error: "To reschedule, provide BOTH `start` and `end`. To leave the schedule unchanged, omit BOTH.",
              });
            }

            if (hasStart && hasEnd) {
              const parsedStart = parseIso(start);
              const parsedEnd = parseIso(end);
              if (!parsedStart) {
                return errorResult({ error: `Invalid \`start\` "${start}". Expected ISO 8601.` });
              }
              if (!parsedEnd) {
                return errorResult({ error: `Invalid \`end\` "${end}". Expected ISO 8601.` });
              }
              if (parsedStart.kind !== parsedEnd.kind) {
                return errorResult({
                  error: "`start` and `end` must be the same kind (both date-only or both datetime).",
                });
              }
              const times = await buildEventTimes(
                googleToken, calendarId, parsedStart, parsedEnd, params.timeZone, (params.recurrence?.length ?? 0) > 0,
              );
              if ('isError' in times) return times;
              Object.assign(updates, times);
            }

            const encodedCalendarId = encodeURIComponent(calendarId);
            const encodedEventId = encodeURIComponent(eventId);
            const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodedCalendarId}/events/${encodedEventId}`);
            url.searchParams.set('sendUpdates', sendUpdates);
            if (updates.conferenceData) url.searchParams.set('conferenceDataVersion', '1');

            // Google requires a named zone on recurring timed events, so turning an
            // existing offset-only event into a series re-sends its times with one
            const makingRecurring = (params.recurrence?.length ?? 0) > 0 && !hasStart;
            let current: CalendarEvent | undefined;
            if (incremental || makingRecurring) {
              const loaded = await fetchEvent(googleToken, calendarId, eventId, "load event before updating");
              if ('isError' in loaded) return loaded;
              current = loaded;
            }

            if (makingRecurring && current?.start?.dateTime && current.end?.dateTime && !current.start.timeZone) {
              const tz = params.timeZone ?? await fetchCalendarTimeZone(googleToken, calendarId);
              if (typeof tz !== 'string') return tz;
              updates.start = { dateTime: current.start.dateTime, timeZone: tz };
              updates.end = { dateTime: current.end.dateTime, timeZone: tz };
            }

            let ifMatch: string | undefined;
            if (attendees !== undefined) {
              updates.attendees = normalizeAttendees(attendees) || [];
            } else if (current && incremental) {
              if (current.attendeesOmitted === true) {
                return errorResult({
                  error: `Google truncated the guest list for event "${current.summary || eventId}", so changing attendees here would drop the ones it left out. Edit the guest list in Google Calendar directly.`,
                  resource: "event",
                  resourceId: eventId,
                });
              }
              updates.attendees = mergeAttendees(
                current.attendees,
                normalizeAttendees(addAttendees) || [],
                removeAttendees || [],
              );
              if (typeof current.etag === 'string' && current.etag.length > 0) ifMatch = current.etag;
            }

            const res = await googleFetch(url.toString(), {
              method: 'PATCH',
              headers: {
                'Authorization': `Bearer ${googleToken}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                ...(ifMatch && { 'If-Match': ifMatch }),
              },
              body: JSON.stringify(updates),
            });
            if (!res.ok && res.status === 412) {
              return errorResult({
                error: `Event "${eventId}" was changed by someone else between reading its guest list and updating it, so nothing was saved. Try again.`,
                resource: "event",
                resourceId: eventId,
              });
            }
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

            return okResult(toStructuredEvent(updatedEvent));
          } catch (error: any) {
            return errorResult({ error: `Unexpected error in update_event: ${error?.message || String(error)}` });
          }
        })
      },

      respond_to_event: {
        description:
          "RSVP to a Google Calendar event as the authenticated user ONLY (accept, decline, or tentatively accept). " +
          "Use this — NOT update_event — to set your own response: update_event replaces the whole attendee list and resets everyone's responseStatus to needsAction, whereas this tool reads the event, changes ONLY your own attendee entry (matched by your own email address), and echoes back every other attendee untouched so their responses are preserved. " +
          "Always prefer calendarId='primary' (the default) — on a shared or delegated calendar your attendee entry cannot always be identified safely. " +
          "For a recurring event, passing the series eventId responds for the ENTIRE series, while passing a single instance ID ('<eventId>_<UTC timestamp>', e.g. 'abc123_20240115T170000Z') responds for that one occurrence only. " +
          "Optionally attach a `comment` for the organizer. `sendUpdates` controls whether your response notifies others. " +
          "Returns the event with your updated response {id, summary, myResponseStatus, myComment, attendees, ...}, where myComment is your currently stored response comment (omitted when you have none).",
        outputSchema: {
          id: z.string(),
          summary: z.string().optional(),
          start: formattedDateTimeSchema,
          end: formattedDateTimeSchema,
          myResponseStatus: z.string(),
          myComment: z.string().optional(),
          attendees: z.array(attendeeSchema).optional(),
          htmlLink: z.string().optional(),
          conferenceData: conferenceDataSchema.optional(),
          status: z.string().optional(),
          updated: z.string().optional(),
          message: z.string(),
        },
        schema: {
          calendarId: z
            .string()
            .optional()
            .default("primary")
            .describe('Calendar the event lives on. Defaults to "primary" (your own calendar), which is required for self-detection.'),
          eventId: z
            .string()
            .describe("Event ID to respond to (from get_calendar_events). For a recurring event, the series ID responds for the whole series; a single instance ID ('<eventId>_<UTC timestamp>') responds for that occurrence only."),
          responseStatus: z
            .enum(['accepted', 'declined', 'tentative'])
            .describe('Your RSVP: accepted, declined, or tentative.'),
          comment: z.string().optional().describe('Optional response comment shown to the organizer.'),
          sendUpdates: z
            .enum(['all', 'externalOnly', 'none'])
            .optional()
            .default('all')
            .describe('Whether to notify others of your response. all / externalOnly / none.'),
        },
        handler: requirePermissionSecure("https://www.googleapis.com/auth/calendar.events", async (params: any, context: any) => {
          try {
            const googleToken = context.accessToken;
            const { calendarId, eventId, responseStatus, comment, sendUpdates } = params;

            const encodedCalendarId = encodeURIComponent(calendarId);
            const encodedEventId = encodeURIComponent(eventId);
            const eventUrl = `https://www.googleapis.com/calendar/v3/calendars/${encodedCalendarId}/events/${encodedEventId}`;

            const callerEmail = calendarId === 'primary'
              ? undefined
              : await resolveCallerEmailFromPrimaryCalendar(googleToken);

            const buildRsvpResult = (
              ev: CalendarEvent,
              myResponseStatus: string,
              message: string,
              myComment?: unknown,
            ) => {
              const sanitizedConf = sanitizeConferenceData(ev.conferenceData);
              return okResult({
                id: ev.id,
                ...(typeof ev.summary === 'string' && { summary: ev.summary }),
                start: formatDateTimeWithDay(ev.start),
                end: formatDateTimeWithDay(ev.end),
                myResponseStatus,
                ...(typeof myComment === 'string' && myComment.length > 0 && { myComment }),
                attendees: (ev.attendees || [])
                  .filter(a => typeof a.email === 'string')
                  .map(a => ({ email: a.email, responseStatus: a.responseStatus || null })),
                ...(typeof ev.htmlLink === 'string' && { htmlLink: ev.htmlLink }),
                ...(sanitizedConf && { conferenceData: sanitizedConf }),
                status: ev.status,
                updated: ev.updated,
                message,
              });
            };

            const concurrentEditError = {
              error: `Event "${eventId}" is being changed by someone else right now, so your response was not saved (retrying immediately would risk overwriting their change). Try again in a moment.`,
              resource: "event",
              resourceId: eventId,
            };

            for (let attempt = 1; attempt <= 2; attempt++) {
              const getRes = await googleFetch(eventUrl, {
                headers: {
                  'Authorization': `Bearer ${googleToken}`,
                  'Accept': 'application/json',
                },
              });
              if (!getRes.ok) {
                return errorResult(mapGoogleError(getRes, {
                  operation: "load event to respond to",
                  resource: "event",
                  resourceId: eventId,
                }));
              }

              const event = (getRes.bodyJson as CalendarEvent) || ({} as CalendarEvent);
              const attendees = event.attendees || [];
              const eventLabel = event.summary || eventId;

              if (event.status === 'cancelled') {
                return errorResult({
                  error: `Event "${eventLabel}" has been cancelled, so there is nothing to respond to.`,
                  resource: "event",
                  resourceId: eventId,
                });
              }

              const match = identifyCallerAttendee(attendees, callerEmail, calendarId);

              if (match.kind === 'unverifiableCalendar') {
                return errorResult({
                  error: `Your email address could not be determined, so your attendee entry on calendar "${calendarId}" cannot be proven to be yours (Google's 'self' flag identifies the calendar owner, not you). Call this tool again with calendarId='primary' to RSVP on your own calendar.`,
                  resource: "event",
                  resourceId: eventId,
                });
              }

              if (match.kind === 'notFound') {
                if (event.attendeesOmitted === true) {
                  return errorResult({
                    error: `Google truncated the guest list for event "${eventLabel}", so your attendee entry could not be located. Please RSVP in Google Calendar directly.`,
                    resource: "event",
                    resourceId: eventId,
                  });
                }
                return errorResult({
                  error: attendees.length === 0
                    ? `Event "${eventLabel}" has no attendees, so there is no invitation for you to respond to.`
                    : `Could not find your attendee entry on event "${eventLabel}". Make sure you are invited and that calendarId is your own calendar (use "primary").`,
                  resource: "event",
                  resourceId: eventId,
                  attendees: describeAttendeeRoster(attendees),
                });
              }

              const self = match.attendee;

              if (self.responseStatus === responseStatus && (comment === undefined || self.comment === comment)) {
                return buildRsvpResult(
                  event,
                  responseStatus,
                  `Your response to "${eventLabel}" was already ${responseStatus}, so nothing was changed and no notifications were sent.`,
                  self.comment,
                );
              }

              if (event.attendeesOmitted === true) {
                return errorResult({
                  error: `Google truncated the guest list for event "${eventLabel}", so responding here would delete the attendees it left out. Please RSVP in Google Calendar directly.`,
                  resource: "event",
                  resourceId: eventId,
                });
              }

              const updatedAttendees = attendees.map(attendee => attendee === self
                ? { ...attendee, responseStatus, ...(comment !== undefined && { comment }) }
                : attendee);

              const patchUrl = new URL(eventUrl);
              patchUrl.searchParams.set('sendUpdates', sendUpdates);

              const patchHeaders: Record<string, string> = {
                'Authorization': `Bearer ${googleToken}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
              };
              if (typeof event.etag === 'string' && event.etag.length > 0) {
                patchHeaders['If-Match'] = event.etag;
              }

              const patchRes = await googleFetch(patchUrl.toString(), {
                method: 'PATCH',
                headers: patchHeaders,
                body: JSON.stringify({ attendees: updatedAttendees }),
              });

              if (!patchRes.ok && patchRes.status === 412) {
                if (attempt === 1) continue;
                return errorResult(concurrentEditError);
              }

              if (!patchRes.ok) {
                return errorResult(mapGoogleError(patchRes, {
                  operation: "submit your event response",
                  resource: "event",
                  resourceId: eventId,
                }));
              }

              try {
                const updatedEvent = (patchRes.bodyJson as CalendarEvent) || ({} as CalendarEvent);
                if (!updatedEvent.id) {
                  return errorResult({
                    error: `Your ${responseStatus} response to event "${eventId}" WAS submitted successfully, but Google returned an unexpected response with no event id, so it could not be confirmed. Do NOT retry — retrying would re-notify every attendee. Read the event back to confirm.`,
                    resource: "event",
                    resourceId: eventId,
                    bodyText: truncateBody(patchRes.bodyText),
                  });
                }

                const updatedMatch = identifyCallerAttendee(updatedEvent.attendees || [], callerEmail, calendarId);
                const storedStatus = updatedMatch.kind === 'found' ? updatedMatch.attendee.responseStatus : undefined;
                const storedComment = updatedMatch.kind === 'found' ? updatedMatch.attendee.comment : undefined;
                const eventName = updatedEvent.summary || eventId;

                let message: string;
                if (!storedStatus) {
                  message = `Your ${responseStatus} response to "${eventName}" was submitted, but Google's reply did not include your attendee entry, so the stored value could not be confirmed.`;
                } else if (storedStatus !== responseStatus) {
                  message = `Your response to "${eventName}" was submitted as ${responseStatus}, but Google reports it as ${storedStatus}.`;
                } else {
                  message = `Your response to "${eventName}" was set to ${storedStatus}.`;
                }

                return buildRsvpResult(updatedEvent, storedStatus || 'unknown', message, storedComment);
              } catch (postWriteError: any) {
                return errorResult({
                  error: `Your ${responseStatus} response to event "${eventId}" WAS submitted successfully, but the confirmation could not be read: ${postWriteError?.message || String(postWriteError)}. Do NOT retry — retrying would re-notify every attendee. Read the event back to confirm.`,
                  resource: "event",
                  resourceId: eventId,
                });
              }
            }

            return errorResult(concurrentEditError);
          } catch (error: any) {
            return errorResult({ error: `Unexpected error in respond_to_event: ${error?.message || String(error)}` });
          }
        })
      },

      delete_event: {
        description:
          "Permanently delete an event by `eventId` — there is NO undo. " +
          "Sends cancellation notifications to attendees by default; set `sendUpdates: 'none'` to delete silently. " +
          "Returns {success, eventId, message} on success. " +
          "If the event was already deleted, Google returns 410 and this tool surfaces a structured error — do not retry.",
        destructiveHint: true,
        outputSchema: {
          success: z.boolean(),
          eventId: z.string(),
          message: z.string(),
        },
        schema: {
          calendarId: z
            .string()
            .optional()
            .default("primary")
            .describe('Calendar containing the event. Defaults to "primary".'),
          eventId: z.string().describe('Event ID to delete (from get_calendar_events or create_event).'),
          sendUpdates: z
            .enum(['all', 'externalOnly', 'none'])
            .optional()
            .default('all')
            .describe('Cancellation notification behaviour. all / externalOnly / none.'),
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
        description:
          "Find the next time slots that are free on EVERY listed calendar by scanning Google's free/busy data. " +
          "Pass `calendarIds` (email addresses of the people to meet, or calendar IDs) to find a slot that works for several people; `calendarId` (default primary) is always included. " +
          "Pass `startFrom` as ISO 8601 (date-only, naive datetime, or with offset). Defaults to NOW. " +
          "`duration` is the desired meeting length in minutes. " +
          "Restrict to a daily window via `searchHoursStart`/`searchHoursEnd` (HH:MM[:SS] in `timezone`). " +
          "Restrict to specific weekdays via `includeDays` (default: Mon-Fri). " +
          "Slots align to `startTimeIncrement` (default 30 min) boundaries. " +
          "Returns up to `maxResults` slots (default 10) and a boolean `exhausted` flag — when `exhausted` is true, the full search window was scanned and no more slots exist; when false, paginate by calling again with `startFrom = searchedUntil`. " +
          "CAVEAT: free/busy reflects ONLY the listed calendars — meetings on other calendars the user attends are NOT considered. Surface this to the user before confirming a slot.",
        readOnlyHint: true,
        outputSchema: {
          calendarId: z.string(),
          calendarIds: z.array(z.string()),
          availableSlots: z.array(z.object({
            start: formattedDateTimeSchema,
            end: formattedDateTimeSchema,
          })),
          searchedUntil: z.string(),
          exhausted: z.boolean(),
        },
        schema: {
          calendarId: z
            .string()
            .optional()
            .default("primary")
            .describe('Calendar ID. Defaults to "primary".'),
          calendarIds: z
            .array(z.string())
            .max(49)
            .optional()
            .describe('Additional calendars (max 49) that must ALSO be free, e.g. attendee email addresses ["alice@example.com"]. Their free/busy must be visible to the user.'),
          duration: z.coerce.number().int().positive().describe('Meeting length in minutes (e.g., 30, 60, 90). Required.'),
          timezone: z.string().describe('IANA timezone (e.g., "America/New_York", "UTC"). Used for `searchHoursStart`/`searchHoursEnd` and to format response times.'),
          startFrom: z
            .string()
            .optional()
            .describe('Start searching from this ISO 8601 instant. Date-only ("YYYY-MM-DD") starts at 00:00:00 in `timezone`. Datetime forms work too. Defaults to NOW.'),
          searchHoursStart: z
            .string()
            .regex(/^([01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/, 'searchHoursStart must be HH:MM or HH:MM:SS in 24-hour format')
            .optional()
            .describe('Daily window start as HH:MM[:SS] in `timezone` (e.g. "09:00"). If omitted, all hours are considered.'),
          searchHoursEnd: z
            .string()
            .regex(/^([01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/, 'searchHoursEnd must be HH:MM or HH:MM:SS in 24-hour format')
            .optional()
            .describe('Daily window end as HH:MM[:SS] in `timezone` (e.g. "17:00"). If omitted, all hours are considered.'),
          includeDays: z
            .array(z.enum(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']))
            .optional()
            .default(['Mon', 'Tue', 'Wed', 'Thu', 'Fri'])
            .describe('Weekdays to include. Default: weekdays only.'),
          startTimeIncrement: z
            .coerce.number().int().positive()
            .optional()
            .default(30)
            .describe('Minutes between candidate start times (e.g. 15, 30). Default 30.'),
          maxResults: z
            .coerce.number().int().positive()
            .optional()
            .default(10)
            .describe('Maximum slots to return. Default 10.'),
          maxSearchDays: z
            .coerce.number().int().positive().max(365)
            .optional()
            .default(30)
            .describe('Maximum days ahead of `startFrom` to scan. Default 30, hard cap 365.'),
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
              startFrom,
              startTimeIncrement,
              calendarId,
              calendarIds,
              maxResults,
              maxSearchDays,
            } = params;

            const allCalendarIds: string[] = [calendarId, ...(calendarIds || [])]
              .filter((id, i, arr) => arr.indexOf(id) === i);

            // Resolve startFrom — default to now.
            let searchStart: Date;
            if (!startFrom) {
              searchStart = new Date();
            } else {
              const parsed = parseIso(startFrom);
              if (!parsed) {
                return errorResult({
                  error: `Invalid \`startFrom\` "${startFrom}". Expected ISO 8601 (date or datetime).`,
                });
              }
              let resolved: string;
              if (parsed.kind === "date") {
                resolved = attachOffsetForTimezone(`${parsed.date}T00:00:00`, timezone);
              } else if (parsed.hasOffset) {
                resolved = parsed.rfc3339;
              } else {
                resolved = attachOffsetForTimezone(parsed.rfc3339, timezone);
              }
              searchStart = new Date(resolved);
              if (Number.isNaN(searchStart.getTime())) {
                return errorResult({ error: `Could not interpret \`startFrom\` "${startFrom}" in timezone "${timezone}".` });
              }
            }

            const searchEnd = new Date(searchStart);
            searchEnd.setDate(searchEnd.getDate() + maxSearchDays);

            const requestBody: any = {
              timeMin: searchStart.toISOString(),
              timeMax: searchEnd.toISOString(),
              timeZone: timezone,
              items: allCalendarIds.map(id => ({ id })),
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

            const busyTimes: Array<{start: Date, end: Date}> = [];
            for (const id of allCalendarIds) {
              const calendarData = data.calendars?.[id];
              if (!calendarData) {
                return errorResult({
                  operation: "query free/busy for calendar",
                  resource: "calendar",
                  resourceId: id,
                  error: `Calendar ID "${id}" not present in free/busy response. Verify the ID via list_calendars.`,
                });
              }

              if (calendarData.errors && calendarData.errors.length > 0) {
                const e = calendarData.errors[0];
                return errorResult({
                  operation: "query free/busy for calendar",
                  resource: "calendar",
                  resourceId: id,
                  googleReason: e.reason,
                  error:
                    e.reason === 'notFound'
                      ? `Calendar "${id}" not found. Verify via list_calendars.`
                      : e.reason === 'forbidden'
                        ? `Access denied for calendar "${id}". The authenticated user cannot read its free/busy info.`
                        : `Free/busy lookup failed for calendar "${id}": ${e.reason || 'unknown error'}.`,
                });
              }

              for (const busyPeriod of calendarData.busy || []) {
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

            // Search for available slots using the pure helpers in src/lib/datetime.ts.
            while (availableSlots.length < maxResults && currentTime < searchEnd) {
              // Align to next slot boundary
              currentTime = alignToSlotBoundary(currentTime, startTimeIncrement);

              const slotStart = new Date(currentTime);
              const slotEnd = new Date(slotStart);
              slotEnd.setMinutes(slotEnd.getMinutes() + duration);

              const startInWindow = isWithinSearchHours(slotStart, {
                timeZone: timezone,
                includeDays,
                searchHoursStart,
                searchHoursEnd,
                boundary: 'start',
              });
              const endInWindow = isWithinSearchHours(slotEnd, {
                timeZone: timezone,
                includeDays,
                searchHoursStart,
                searchHoursEnd,
                boundary: 'end',
              });
              if (startInWindow && endInWindow) {
                if (!isSlotBusy(slotStart, slotEnd, busyTimes)) {
                  const startISO = toLocalISO(slotStart, timezone);
                  const endISO = toLocalISO(slotEnd, timezone);

                  const startDate = startISO.split('T')[0];
                  const startTime = startISO.split('T')[1];
                  const endDate = endISO.split('T')[0];
                  const endTime = endISO.split('T')[1];

                  availableSlots.push({
                    start: {
                      date: startDate,
                      time: startTime,
                      dayOfWeek: getDayOfWeek(startISO)
                    },
                    end: {
                      date: endDate,
                      time: endTime,
                      dayOfWeek: getDayOfWeek(endISO)
                    }
                  });
                }
              }

              // Move to next slot
              currentTime = advanceToNextSlot(currentTime, startTimeIncrement);
            }

            // searchedUntil = the next position the search WOULD consider next.
            // For pagination, callers can pass this back as `startFrom` to resume.
            // Clamp to searchEnd so we never report past the window boundary.
            const searchedUntil = currentTime > searchEnd ? searchEnd : currentTime;

            // exhausted: we walked off the end of the window without filling maxResults.
            const exhausted = availableSlots.length < maxResults;

            return okResult({
              calendarId,
              calendarIds: allCalendarIds,
              availableSlots,
              searchedUntil: toLocalISO(searchedUntil, timezone),
              exhausted,
            });
          } catch (error: any) {
            return errorResult({ error: `Unexpected error in get_next_availability: ${error?.message || String(error)}` });
          }
        })
      }
    };
  }
}