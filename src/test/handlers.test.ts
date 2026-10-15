import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { requestContext } from '../auth.js';
import { GoogleCalendarTools } from '../tools.js';

type Call = { url: URL; method: string; headers: Record<string, string>; body?: any };

const calls: Call[] = [];
const responses: Array<{ status?: number; body: unknown }> = [];

function enqueue(body: unknown, status = 200) {
  responses.push({ status, body });
}

function stubFetch() {
  return vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    calls.push({
      url: new URL(String(input)),
      method: init.method ?? 'GET',
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const next = responses.shift() ?? { status: 200, body: {} };
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

async function run(tool: string, args: Record<string, unknown>) {
  const t = (GoogleCalendarTools.getTools() as any)[tool];
  const parsed = z.object(t.schema).parse(args);
  return requestContext.run({ accessToken: 'token' }, () => t.handler(parsed));
}

const calendarBody = { id: 'joao@example.com', timeZone: 'America/Recife' };
const eventBody = {
  id: 'ev1',
  summary: 'Sync',
  start: { dateTime: '2026-10-20T10:00:00-03:00' },
  end: { dateTime: '2026-10-20T10:30:00-03:00' },
};

beforeEach(() => {
  calls.length = 0;
  responses.length = 0;
  vi.stubGlobal('fetch', stubFetch());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('get_calendar_events', () => {
  it('forwards a free-text query and drops the default lower bound so the whole calendar is searched', async () => {
    enqueue({ items: [] });
    await run('get_calendar_events', { q: 'budget review' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url.searchParams.get('q')).toBe('budget review');
    expect(calls[0].url.searchParams.has('timeMin')).toBe(false);
    expect(calls[0].url.searchParams.has('timeZone')).toBe(false);
  });

  it('keeps the default lower bound of now when no query is given', async () => {
    enqueue({ items: [] });
    await run('get_calendar_events', {});
    expect(calls[0].url.searchParams.get('timeMin')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('interprets naive bounds in the calendar time zone when no timeZone is given', async () => {
    enqueue(calendarBody);
    enqueue({ items: [] });
    await run('get_calendar_events', { timeMin: '2026-10-20', timeMax: '2026-10-21T12:00:00' });
    expect(calls[0].url.pathname).toBe('/calendar/v3/calendars/primary');
    expect(calls[1].url.searchParams.get('timeMin')).toBe('2026-10-20T00:00:00-03:00');
    expect(calls[1].url.searchParams.get('timeMax')).toBe('2026-10-21T12:00:00-03:00');
    expect(calls[1].url.searchParams.has('timeZone')).toBe(false);
  });

  it('does not look up the calendar when the bounds carry their own offset', async () => {
    enqueue({ items: [] });
    await run('get_calendar_events', { timeMin: '2026-10-20T00:00:00Z' });
    expect(calls).toHaveLength(1);
  });

  it('reports the calendar lookup failure instead of guessing UTC', async () => {
    enqueue({ error: { message: 'nope' } }, 403);
    const res = await run('get_calendar_events', { timeMin: '2026-10-20' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('time zone');
    expect(calls).toHaveLength(1);
  });

  it('exposes organizer, rich attendees and event flags in the output', async () => {
    enqueue({
      items: [{
        ...eventBody,
        organizer: { email: 'org@example.com', displayName: 'Org', self: false },
        creator: { email: 'cre@example.com' },
        attendees: [{ email: 'me@example.com', self: true, responseStatus: 'accepted', optional: true, displayName: 'Me' }],
        colorId: '5',
        visibility: 'private',
        transparency: 'transparent',
        eventType: 'focusTime',
        reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 15 }] },
        status: 'confirmed',
        created: '2026-10-01T00:00:00Z',
        updated: '2026-10-02T00:00:00Z',
      }],
    });
    const res = await run('get_calendar_events', { timeMin: '2026-10-20T00:00:00Z' });
    const ev = res.structuredContent.events[0];
    expect(ev.organizer).toEqual({ email: 'org@example.com', displayName: 'Org' });
    expect(ev.creator).toEqual({ email: 'cre@example.com' });
    expect(ev.attendees).toEqual([
      { email: 'me@example.com', responseStatus: 'accepted', displayName: 'Me', optional: true, self: true },
    ]);
    expect(ev).toMatchObject({
      colorId: '5',
      visibility: 'private',
      availability: 'free',
      eventType: 'focusTime',
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 15 }] },
      status: 'confirmed',
      created: '2026-10-01T00:00:00Z',
      updated: '2026-10-02T00:00:00Z',
    });
  });

  it('reports busy availability and omits absent optional fields', async () => {
    enqueue({ items: [eventBody] });
    const res = await run('get_calendar_events', { timeMin: '2026-10-20T00:00:00Z' });
    const ev = res.structuredContent.events[0];
    expect(ev.availability).toBe('busy');
    expect(ev).not.toHaveProperty('organizer');
    expect(ev).not.toHaveProperty('colorId');
    expect(ev).not.toHaveProperty('reminders');
  });
});

describe('create_event', () => {
  it('resolves the calendar time zone for a naive start when none is given', async () => {
    enqueue(calendarBody);
    enqueue(eventBody);
    await run('create_event', { summary: 'Sync', start: '2026-10-20T10:00:00', end: '2026-10-20T10:30:00' });
    expect(calls[0].url.pathname).toBe('/calendar/v3/calendars/primary');
    expect(calls[1].body.start).toEqual({ dateTime: '2026-10-20T10:00:00', timeZone: 'America/Recife' });
  });

  it('does not look up the calendar for an all-day event or an explicit timeZone', async () => {
    enqueue(eventBody);
    await run('create_event', { summary: 'Day', start: '2026-10-20', end: '2026-10-21' });
    expect(calls).toHaveLength(1);
    enqueue(eventBody);
    await run('create_event', { summary: 'Sync', start: '2026-10-20T10:00:00', end: '2026-10-20T10:30:00', timeZone: 'UTC' });
    expect(calls).toHaveLength(2);
    expect(calls[1].body.start).toEqual({ dateTime: '2026-10-20T10:00:00', timeZone: 'UTC' });
  });

  it('sends the extra event options and asks Google to build the Meet link', async () => {
    enqueue(calendarBody);
    enqueue(eventBody);
    await run('create_event', {
      summary: 'Sync',
      start: '2026-10-20T10:00:00Z',
      end: '2026-10-20T10:30:00Z',
      recurrence: ['RRULE:FREQ=DAILY;COUNT=3'],
      colorId: '7',
      visibility: 'public',
      availability: 'free',
      reminders: { overrides: [{ method: 'email', minutes: 60 }] },
      addGoogleMeet: true,
    });
    const { url, body } = calls[1];
    expect(url.searchParams.get('conferenceDataVersion')).toBe('1');
    expect(body).toMatchObject({
      recurrence: ['RRULE:FREQ=DAILY;COUNT=3'],
      colorId: '7',
      visibility: 'public',
      transparency: 'transparent',
      reminders: { useDefault: false, overrides: [{ method: 'email', minutes: 60 }] },
    });
    expect(body.conferenceData.createRequest.conferenceSolutionKey).toEqual({ type: 'hangoutsMeet' });
    expect(typeof body.conferenceData.createRequest.requestId).toBe('string');
  });

  it('refuses to create a naive-time event when the calendar time zone cannot be read', async () => {
    enqueue({ error: { message: 'nope' } }, 500);
    const res = await run('create_event', { summary: 'Sync', start: '2026-10-20T10:00:00', end: '2026-10-20T10:30:00' });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('always names a time zone on a recurring timed event, even with offset-bearing inputs', async () => {
    enqueue(calendarBody);
    enqueue(eventBody);
    await run('create_event', {
      summary: 'Weekly',
      start: '2026-10-20T10:00:00-03:00',
      end: '2026-10-20T10:30:00-03:00',
      recurrence: ['RRULE:FREQ=WEEKLY'],
    });
    expect(calls[1].body.start).toEqual({ dateTime: '2026-10-20T10:00:00-03:00', timeZone: 'America/Recife' });
  });

  it('leaves conferenceDataVersion off when no Meet link is requested', async () => {
    enqueue(eventBody);
    await run('create_event', { summary: 'Sync', start: '2026-10-20T10:00:00Z', end: '2026-10-20T10:30:00Z' });
    expect(calls[0].url.searchParams.has('conferenceDataVersion')).toBe(false);
    expect(calls[0].body).not.toHaveProperty('conferenceData');
  });
});

describe('update_event', () => {
  it('adds and removes attendees without resetting everyone else', async () => {
    enqueue({
      ...eventBody,
      etag: '"etag-1"',
      attendees: [
        { email: 'keep@example.com', responseStatus: 'accepted' },
        { email: 'gone@example.com', responseStatus: 'declined' },
      ],
    });
    enqueue(eventBody);
    await run('update_event', {
      eventId: 'ev1',
      addAttendees: ['new@example.com'],
      removeAttendees: ['gone@example.com'],
      sendUpdates: 'none',
    });
    expect(calls[0].method).toBe('GET');
    expect(calls[1].method).toBe('PATCH');
    expect(calls[1].headers['If-Match']).toBe('"etag-1"');
    expect(calls[1].body.attendees).toEqual([
      { email: 'keep@example.com', responseStatus: 'accepted' },
      { email: 'new@example.com' },
    ]);
  });

  it('reports a concurrent edit instead of overwriting it when the guest list changed underneath', async () => {
    enqueue({ ...eventBody, etag: '"etag-1"', attendees: [] });
    enqueue({ error: { message: 'Precondition Failed' } }, 412);
    const res = await run('update_event', { eventId: 'ev1', addAttendees: ['b@example.com'] });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/changed by someone else/i);
  });

  it('rejects mixing a full attendee replacement with incremental changes', async () => {
    const res = await run('update_event', { eventId: 'ev1', attendees: ['a@example.com'], addAttendees: ['b@example.com'] });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('refuses incremental attendee changes when Google truncated the guest list', async () => {
    enqueue({ ...eventBody, attendees: [], attendeesOmitted: true });
    const res = await run('update_event', { eventId: 'ev1', addAttendees: ['b@example.com'] });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('patches event options and a Meet link request', async () => {
    enqueue(eventBody);
    await run('update_event', { eventId: 'ev1', colorId: '2', availability: 'busy', addGoogleMeet: true });
    expect(calls[0].url.searchParams.get('conferenceDataVersion')).toBe('1');
    expect(calls[0].body).toMatchObject({ colorId: '2', transparency: 'opaque' });
    expect(calls[0].body.conferenceData.createRequest.conferenceSolutionKey).toEqual({ type: 'hangoutsMeet' });
  });

  it('re-sends the stored times with a named zone when making an offset-only event recurring', async () => {
    enqueue({ ...eventBody, etag: '"e"' });
    enqueue(calendarBody);
    enqueue(eventBody);
    await run('update_event', { eventId: 'ev1', recurrence: ['RRULE:FREQ=WEEKLY'] });
    expect(calls.map(c => c.method)).toEqual(['GET', 'GET', 'PATCH']);
    expect(calls[2].body).toMatchObject({
      recurrence: ['RRULE:FREQ=WEEKLY'],
      start: { dateTime: '2026-10-20T10:00:00-03:00', timeZone: 'America/Recife' },
      end: { dateTime: '2026-10-20T10:30:00-03:00', timeZone: 'America/Recife' },
    });
  });

  it('leaves the times alone when the event already stores a named zone', async () => {
    enqueue({
      ...eventBody,
      start: { ...eventBody.start, timeZone: 'Europe/Lisbon' },
      end: { ...eventBody.end, timeZone: 'Europe/Lisbon' },
    });
    enqueue(eventBody);
    await run('update_event', { eventId: 'ev1', recurrence: ['RRULE:FREQ=WEEKLY'] });
    expect(calls.map(c => c.method)).toEqual(['GET', 'PATCH']);
    expect(calls[1].body).not.toHaveProperty('start');
  });

  it('resolves the calendar time zone for naive reschedules when none is given', async () => {
    enqueue(calendarBody);
    enqueue(eventBody);
    await run('update_event', { eventId: 'ev1', start: '2026-10-20T15:00:00', end: '2026-10-20T16:00:00' });
    expect(calls[1].body.end).toEqual({ dateTime: '2026-10-20T16:00:00', timeZone: 'America/Recife' });
  });
});

describe('get_event', () => {
  it('lets Google format times in the calendar time zone when none is given', async () => {
    enqueue(eventBody);
    await run('get_event', { eventId: 'ev1' });
    expect(calls[0].url.searchParams.has('timeZone')).toBe(false);
  });
});

describe('get_next_availability', () => {
  const day = (h: number) => `2026-10-20T${String(h).padStart(2, '0')}:00:00Z`;

  it('unions busy time across every requested calendar', async () => {
    enqueue({
      calendars: {
        primary: { busy: [{ start: day(9), end: day(10) }] },
        'bob@example.com': { busy: [{ start: day(10), end: day(11) }] },
      },
    });
    const res = await run('get_next_availability', {
      duration: 60,
      timezone: 'UTC',
      startFrom: '2026-10-20T09:00:00Z',
      calendarIds: ['bob@example.com'],
      maxResults: 1,
    });
    expect(calls[0].body.items).toEqual([{ id: 'primary' }, { id: 'bob@example.com' }]);
    expect(res.structuredContent.calendarIds).toEqual(['primary', 'bob@example.com']);
    expect(res.structuredContent.availableSlots[0].start.time).toBe('11:00:00');
  });

  it('rejects more calendars than one free/busy query can hold', async () => {
    await expect(run('get_next_availability', {
      duration: 30,
      timezone: 'UTC',
      calendarIds: Array.from({ length: 50 }, (_, i) => `p${i}@example.com`),
    })).rejects.toThrow();
  });

  it('names the calendar that failed in a multi-calendar lookup', async () => {
    enqueue({
      calendars: {
        primary: { busy: [] },
        'bob@example.com': { errors: [{ reason: 'notFound' }], busy: [] },
      },
    });
    const res = await run('get_next_availability', {
      duration: 30,
      timezone: 'UTC',
      calendarIds: ['bob@example.com'],
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('bob@example.com');
  });
});
