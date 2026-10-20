import { ToolFailure, fail, type FailurePayload } from "../lib/failure.js";
import type { CalendarEvent } from "../lib/event-model.js";

const API_BASE = "https://www.googleapis.com/calendar/v3";
const GOOGLE_FETCH_TIMEOUT_MS = 25_000;

type GoogleFetchFailure = {
  ok: false;
  kind: "http" | "network" | "timeout" | "parse";
  status: number;
  statusText: string;
  bodyText: string;
  bodyJson?: unknown;
  retryAfterSeconds?: number;
  cause?: string;
};

export type GoogleFetchResult =
  | { ok: true; status: number; bodyText: string; bodyJson: unknown }
  | GoogleFetchFailure;

function causeOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function parseRetryAfter(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

async function googleFetch(url: string, init: RequestInit): Promise<GoogleFetchResult> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), GOOGLE_FETCH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: ac.signal });
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      kind: aborted ? "timeout" : "network",
      status: 0,
      statusText: aborted ? "Request Timeout" : "Network Error",
      bodyText: "",
      cause: causeOf(err),
    };
  } finally {
    clearTimeout(timer);
  }

  let bodyText: string;
  try {
    bodyText = await response.text();
  } catch (err) {
    return { ok: false, kind: "parse", status: response.status, statusText: response.statusText, bodyText: "", cause: causeOf(err) };
  }
  let bodyJson: unknown;
  try {
    bodyJson = bodyText ? JSON.parse(bodyText) : undefined;
  } catch {
    bodyJson = undefined;
  }

  if (!response.ok) {
    return {
      ok: false,
      kind: "http",
      status: response.status,
      statusText: response.statusText,
      bodyText,
      bodyJson,
      retryAfterSeconds: parseRetryAfter(response.headers.get("Retry-After")),
    };
  }
  return { ok: true, status: response.status, bodyText, bodyJson };
}

export interface GoogleErrorContext {
  operation: string;
  resource?: string;
  resourceId?: string;
}

export function mapGoogleError(result: GoogleFetchFailure, ctx: GoogleErrorContext): FailurePayload {
  const body = result.bodyJson as { error?: { message?: unknown; errors?: Array<{ reason?: unknown }> } } | undefined;
  const googleMessage = typeof body?.error?.message === "string" ? body.error.message : undefined;
  const reason = body?.error?.errors?.[0]?.reason;
  const googleReason = typeof reason === "string" ? reason : undefined;
  const retryAfter = result.retryAfterSeconds;

  const base = {
    operation: ctx.operation,
    status: result.status,
    statusText: result.statusText,
    ...(ctx.resource && { resource: ctx.resource }),
    ...(ctx.resourceId && { resourceId: ctx.resourceId }),
    ...(googleMessage && { googleMessage }),
    ...(googleReason && { googleReason }),
    ...(retryAfter !== undefined && { retryAfterSeconds: retryAfter }),
  };
  const transient = (error: string): FailurePayload => ({ ...base, transient: true, error });
  const permanent = (error: string): FailurePayload => ({ ...base, error });

  if (result.kind === "timeout") {
    return transient(`Timed out while trying to ${ctx.operation}. The Google Calendar API did not respond within ${GOOGLE_FETCH_TIMEOUT_MS / 1000}s. Retry once; if it persists, surface the issue to the user.`);
  }
  if (result.kind === "network") {
    return transient(`Network error while trying to ${ctx.operation}: ${result.cause || "unknown"}. Retry once before surfacing to the user.`);
  }
  if (result.kind === "parse") {
    return transient(`Could not read response body while trying to ${ctx.operation}: ${result.cause || "unknown"}.`);
  }

  const label = ctx.resource && ctx.resourceId ? `${ctx.resource} "${ctx.resourceId}"` : ctx.resource || "resource";
  switch (result.status) {
    case 400:
      return permanent(`Invalid request to ${ctx.operation}: ${googleMessage || result.bodyText || "Google rejected the request as malformed."} Check parameter formats (ISO 8601 datetimes, valid timezone identifiers, time ranges).`);
    case 401:
      return permanent(`Authentication failed while trying to ${ctx.operation}. The user's Google session is invalid or expired and they need to re-authenticate. Do NOT retry; surface this to the user.`);
    case 403:
      if (googleReason === "rateLimitExceeded" || googleReason === "userRateLimitExceeded" || googleReason === "quotaExceeded") {
        return transient(`Google Calendar rate limit hit while trying to ${ctx.operation}${retryAfter !== undefined ? ` (retry after ${retryAfter}s)` : ""}. Back off and try again.`);
      }
      return permanent(`Access denied for ${label} while trying to ${ctx.operation}. The authenticated user does not have permission for this operation. Do NOT retry without changing input.`);
    case 404:
      return permanent(`${label} not found while trying to ${ctx.operation}. Verify the ID is correct (use list_calendars / get_calendar_events to look it up).`);
    case 409:
      return permanent(`Conflict while trying to ${ctx.operation}: ${googleMessage || "the resource may have been modified concurrently or the ID is already in use."}`);
    case 410:
      return permanent(`${label} is gone (HTTP 410). It was likely already deleted. Do NOT retry.`);
    case 412:
      return permanent(`${label} was changed by someone else between reading it and trying to ${ctx.operation}, so nothing was saved. Try again.`);
    case 429:
      return transient(`Google Calendar rate limit hit (HTTP 429) while trying to ${ctx.operation}${retryAfter !== undefined ? `. Wait ${retryAfter}s before retrying.` : ". Back off and retry."}`);
    case 500:
    case 502:
    case 503:
    case 504:
      return transient(`Google Calendar is temporarily unavailable (HTTP ${result.status}) while trying to ${ctx.operation}${retryAfter !== undefined ? `. Wait ${retryAfter}s before retrying.` : ". Retry once after a short delay."}`);
    default:
      return permanent(`Unexpected HTTP ${result.status} (${result.statusText}) while trying to ${ctx.operation}: ${googleMessage || result.bodyText || "no error body"}.`);
  }
}

export function truncateBody(body: string | undefined, maxLength = 300): string {
  const text = String(body ?? "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

export const calendarPath = (calendarId: string) => `/calendars/${encodeURIComponent(calendarId)}`;
export const eventsPath = (calendarId: string) => `${calendarPath(calendarId)}/events`;
export const eventPath = (calendarId: string, eventId: string) => `${eventsPath(calendarId)}/${encodeURIComponent(eventId)}`;

export type Query = Record<string, string | readonly string[] | undefined>;

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  query?: Query;
  body?: unknown;
  ifMatch?: string;
}

const MISSING_EVENT_ID = "Google returned an unexpected response with no event id.";

export class CalendarClient {
  private readonly zones = new Map<string, Promise<string>>();

  constructor(private readonly accessToken: string) {}

  send(path: string, { method = "GET", query = {}, body, ifMatch }: RequestOptions = {}): Promise<GoogleFetchResult> {
    const url = new URL(API_BASE + path);
    for (const [name, value] of Object.entries(query)) {
      for (const item of [value ?? []].flat()) url.searchParams.append(name, item);
    }
    return googleFetch(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        Accept: "application/json",
        ...(body !== undefined && { "Content-Type": "application/json" }),
        ...(ifMatch && { "If-Match": ifMatch }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async call<T>(path: string, options: RequestOptions, ctx: GoogleErrorContext): Promise<T | undefined> {
    const res = await this.send(path, options);
    if (!res.ok) throw new ToolFailure(mapGoogleError(res, ctx));
    return res.bodyJson as T | undefined;
  }

  async event(path: string, options: RequestOptions, ctx: GoogleErrorContext, missingIdError = MISSING_EVENT_ID): Promise<CalendarEvent> {
    const res = await this.send(path, options);
    if (!res.ok) throw new ToolFailure(mapGoogleError(res, ctx));
    const event = res.bodyJson as CalendarEvent | undefined;
    if (!event?.id) fail(missingIdError, { resource: ctx.resource, resourceId: ctx.resourceId, bodyText: truncateBody(res.bodyText) });
    return event;
  }

  getEvent(calendarId: string, eventId: string, operation: string, timeZone?: string): Promise<CalendarEvent> {
    return this.event(eventPath(calendarId, eventId), { query: { timeZone } }, { operation, resource: "event", resourceId: eventId });
  }

  calendarTimeZone(calendarId: string): Promise<string> {
    let zone = this.zones.get(calendarId);
    if (!zone) {
      zone = this.call<{ timeZone?: unknown }>(calendarPath(calendarId), {}, {
        operation: "read the calendar time zone (pass a time zone explicitly to skip this lookup)",
        resource: "calendar",
        resourceId: calendarId,
      }).then((body) => (typeof body?.timeZone === "string" && body.timeZone ? body.timeZone : "UTC"));
      this.zones.set(calendarId, zone);
    }
    return zone;
  }

  zone(calendarId: string, preferred?: string): () => Promise<string> {
    return async () => preferred ?? this.calendarTimeZone(calendarId);
  }
}
