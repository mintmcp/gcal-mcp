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
  it('forwards a free-text query and keeps the default lower bound so upcoming matches come first', async () => {
    enqueue({ items: [] });
    await run('get_calendar_events', { q: 'budget review' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url.searchParams.get('q')).toBe('budget review');
    expect(calls[0].url.searchParams.get('timeMin')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(calls[0].url.searchParams.has('timeZone')).toBe(false);
  });

  it('trims the query and rejects one that is only whitespace', async () => {
    enqueue({ items: [] });
    await run('get_calendar_events', { q: '  budget review  ' });
    expect(calls[0].url.searchParams.get('q')).toBe('budget review');
    await expect(run('get_calendar_events', { q: '   ' })).rejects.toThrow();
  });

  it('keeps the page token when Google returns an empty page with more results behind it', async () => {
    enqueue({ items: [], nextPageToken: 'next' });
    const res = await run('get_calendar_events', { q: 'offsite' });
    expect(res.structuredContent.nextPageToken).toMatch(/^gcalmin1\./);
    expect(res.structuredContent.message).toContain('pageToken');
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
  it('is advertised as destructive, since it can remove guests and end a series', () => {
    expect((GoogleCalendarTools.getTools() as any).update_event.destructiveHint).toBe(true);
  });

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

  it('falls back to the calendar time zone when none is given', async () => {
    enqueue(calendarBody);
    enqueue({ calendars: { primary: { busy: [] } } });
    const res = await run('get_next_availability', {
      duration: 30,
      startFrom: '2026-10-20T09:00:00',
      maxResults: 1,
    });
    expect(calls[0].url.pathname).toBe('/calendar/v3/calendars/primary');
    expect(calls[1].body.timeZone).toBe('America/Recife');
    expect(calls[1].body.timeMin).toBe('2026-10-20T12:00:00.000Z');
    expect(res.structuredContent.availableSlots[0].start.time).toBe('09:00:00');
  });

  it('reports the calendar lookup failure instead of guessing a time zone', async () => {
    enqueue({ error: { message: 'nope' } }, 403);
    const res = await run('get_next_availability', { duration: 30 });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('time zone');
    expect(calls).toHaveLength(1);
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

describe('get_calendar_events filters and ordering', () => {
  it('forwards event type filters, showDeleted and ordering by last update', async () => {
    enqueue({ items: [] });
    await run('get_calendar_events', { eventTypes: ['outOfOffice', 'focusTime'], showDeleted: true, orderBy: 'updated', timeMin: '2026-10-20T00:00:00Z' });
    const p = calls[0].url.searchParams;
    expect(p.getAll('eventTypes')).toEqual(['outOfOffice', 'focusTime']);
    expect(p.get('showDeleted')).toBe('true');
    expect(p.get('orderBy')).toBe('updated');
    expect(p.get('singleEvents')).toBe('true');
  });

  it('orders by start time and leaves the other filters off by default', async () => {
    enqueue({ items: [] });
    await run('get_calendar_events', { timeMin: '2026-10-20T00:00:00Z' });
    const p = calls[0].url.searchParams;
    expect(p.get('orderBy')).toBe('startTime');
    expect(p.has('eventTypes')).toBe(false);
    expect(p.has('showDeleted')).toBe(false);
  });

  it('returns series masters instead of instances when asked not to expand recurring events', async () => {
    enqueue({ items: [] });
    await run('get_calendar_events', { expandRecurring: false, timeMin: '2026-10-20T00:00:00Z' });
    const p = calls[0].url.searchParams;
    expect(p.get('singleEvents')).toBe('false');
    expect(p.has('orderBy')).toBe(false);
  });

  it('refuses start-time ordering of unexpanded series, which Google cannot do', async () => {
    const res = await run('get_calendar_events', { expandRecurring: false, orderBy: 'startTime' });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('exposes attachments, guest permissions and event type settings in the output', async () => {
    enqueue({
      items: [{
        ...eventBody,
        attachments: [{ fileUrl: 'https://drive.google.com/open?id=1a', title: 'Deck', mimeType: 'application/pdf', fileId: '1a', iconLink: 'x' }],
        guestsCanModify: true,
        guestsCanInviteOthers: false,
        eventType: 'focusTime',
        focusTimeProperties: { autoDeclineMode: 'declineNone', chatStatus: 'doNotDisturb' },
      }],
    });
    const res = await run('get_calendar_events', { timeMin: '2026-10-20T00:00:00Z' });
    const ev = res.structuredContent.events[0];
    expect(ev.attachments).toEqual([{ fileUrl: 'https://drive.google.com/open?id=1a', title: 'Deck', mimeType: 'application/pdf', fileId: '1a' }]);
    expect(ev.guestPermissions).toEqual({ canModify: true, canInviteOthers: false });
    expect(ev.focusTime).toEqual({ autoDeclineMode: 'declineNone', chatStatus: 'doNotDisturb' });
  });
});

describe('get_calendar_events pagination with a defaulted lower bound', () => {
  it('freezes the implicit "now" in the page token so the next page continues from the same bound', async () => {
    enqueue({ items: [eventBody], nextPageToken: 'g-token' });
    const first = await run('get_calendar_events', { q: 'sync' });
    const frozenMin = calls[0].url.searchParams.get('timeMin');
    const token = first.structuredContent.nextPageToken;
    expect(token).not.toBe('g-token');

    enqueue({ items: [] });
    await run('get_calendar_events', { q: 'sync', pageToken: token });
    expect(calls[1].url.searchParams.get('pageToken')).toBe('g-token');
    expect(calls[1].url.searchParams.get('timeMin')).toBe(frozenMin);
  });

  it('passes Google tokens through untouched when the caller set the bound explicitly', async () => {
    enqueue({ items: [eventBody], nextPageToken: 'g-token' });
    const res = await run('get_calendar_events', { timeMin: '2026-10-20T00:00:00Z' });
    expect(res.structuredContent.nextPageToken).toBe('g-token');
  });

  it('rejects a frozen token combined with an explicit timeMin, since Google needs identical bounds per page', async () => {
    enqueue({ items: [eventBody], nextPageToken: 'g-token' });
    const first = await run('get_calendar_events', {});
    const res = await run('get_calendar_events', { pageToken: first.structuredContent.nextPageToken, timeMin: '2026-10-20T00:00:00Z' });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(1);
  });
});

describe('create_event attachments, event types and guest permissions', () => {
  it('sends attachments and tells Google the client supports them', async () => {
    enqueue(eventBody);
    await run('create_event', {
      summary: 'Sync', start: '2026-10-20T10:00:00Z', end: '2026-10-20T10:30:00Z',
      attachments: ['1abcdefghij', { fileUrl: 'https://docs.google.com/document/d/1x/edit', title: 'Notes' }],
    });
    expect(calls[0].url.searchParams.get('supportsAttachments')).toBe('true');
    expect(calls[0].body.attachments).toEqual([
      { fileUrl: 'https://drive.google.com/open?id=1abcdefghij' },
      { fileUrl: 'https://docs.google.com/document/d/1x/edit', title: 'Notes' },
    ]);
  });

  it('rejects a malformed attachment before calling Google', async () => {
    const res = await run('create_event', { summary: 'S', start: '2026-10-20', end: '2026-10-21', attachments: ['no good'] });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('creates an out-of-office event and names the type when Google rejects it', async () => {
    enqueue({ error: { message: 'Out of office events must be created on the primary calendar' } }, 400);
    const res = await run('create_event', {
      calendarId: 'team@example.com', summary: 'OOO', start: '2026-10-20T10:00:00Z', end: '2026-10-20T18:00:00Z',
      eventType: 'outOfOffice', outOfOffice: { declineMessage: 'Back Monday' },
    });
    expect(calls[0].body).toMatchObject({
      eventType: 'outOfOffice',
      outOfOfficeProperties: { autoDeclineMode: 'declineAllConflictingInvitations', declineMessage: 'Back Monday' },
    });
    expect(res.isError).toBe(true);
    const err = JSON.parse(res.content[0].text);
    expect(err.eventType).toBe('outOfOffice');
    expect(err.error).toMatch(/primary calendar/);
  });

  it('refuses a multi-day all-day working location up front', async () => {
    const res = await run('create_event', { summary: 'WFH', start: '2026-10-20', end: '2026-10-22', eventType: 'workingLocation' });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
    enqueue(eventBody);
    await run('create_event', { summary: 'WFH', start: '2026-10-20', end: '2026-10-21', eventType: 'workingLocation' });
    expect(calls[0].body).toMatchObject({ eventType: 'workingLocation', visibility: 'public', transparency: 'transparent' });
  });

  it('exposes birthday details in the output', async () => {
    enqueue({ items: [{ ...eventBody, eventType: 'birthday', birthdayProperties: { type: 'birthday', contact: 'people/c1' } }] });
    const res = await run('get_calendar_events', { timeMin: '2026-10-20T00:00:00Z', eventTypes: ['birthday'] });
    expect(res.structuredContent.events[0].birthday).toEqual({ type: 'birthday', contact: 'people/c1' });
  });

  it('refuses an all-day out-of-office or focus-time event up front', async () => {
    const res = await run('create_event', { summary: 'Focus', start: '2026-10-20', end: '2026-10-21', eventType: 'focusTime' });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('sends guest permissions and attendee extras', async () => {
    enqueue({ ...eventBody, attendees: [{ email: 'room@example.com', resource: true, responseStatus: 'accepted' }, { email: 'a@example.com', additionalGuests: 2 }] });
    const res = await run('create_event', {
      summary: 'Sync', start: '2026-10-20T10:00:00Z', end: '2026-10-20T10:30:00Z',
      guestPermissions: { canModify: true, canSeeOtherGuests: false },
      attendees: [{ email: 'room@example.com', resource: true }, { email: 'a@example.com', additionalGuests: 2 }],
      sendUpdates: 'none',
    });
    expect(calls[0].body).toMatchObject({ guestsCanModify: true, guestsCanSeeOtherGuests: false });
    expect(calls[0].body.attendees).toEqual([{ email: 'room@example.com', resource: true }, { email: 'a@example.com', additionalGuests: 2 }]);
    expect(res.structuredContent.attendees).toEqual([
      { email: 'room@example.com', responseStatus: 'accepted', resource: true },
      { email: 'a@example.com', responseStatus: null, additionalGuests: 2 },
    ]);
  });

  it('rejects settings for a different event type before calling Google', async () => {
    const res = await run('create_event', { summary: 'S', start: '2026-10-20T10:00:00Z', end: '2026-10-20T10:30:00Z', eventType: 'outOfOffice', focusTime: {} });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe('update_event reschedule with one bound', () => {
  it('moves the start and keeps the duration when only a new start is given, guarded by the etag it read', async () => {
    enqueue({ ...eventBody, etag: '"e9"' });
    enqueue(calendarBody);
    enqueue(eventBody);
    await run('update_event', { eventId: 'ev1', start: '2026-10-22T15:00:00' });
    expect(calls.map(c => c.method)).toEqual(['GET', 'GET', 'PATCH']);
    expect(calls[2].headers['If-Match']).toBe('"e9"');
    expect(calls[2].body.start).toEqual({ dateTime: '2026-10-22T15:00:00', timeZone: 'America/Recife' });
    expect(calls[2].body.end).toEqual({ dateTime: '2026-10-22T15:30:00', timeZone: 'America/Recife' });
  });

  it('keeps a new end when making an offset-only event recurring in the same call', async () => {
    enqueue({ ...eventBody });
    enqueue(calendarBody);
    enqueue(eventBody);
    await run('update_event', { eventId: 'ev1', end: '2026-10-20T11:00:00-03:00', recurrence: ['RRULE:FREQ=WEEKLY'] });
    expect(calls[2].body.start).toEqual({ dateTime: '2026-10-20T10:00:00-03:00', timeZone: 'America/Recife' });
    expect(calls[2].body.end).toEqual({ dateTime: '2026-10-20T11:00:00-03:00', timeZone: 'America/Recife' });
  });

  it('uses the zone the event already stores for a start-only move', async () => {
    enqueue({ ...eventBody, start: { ...eventBody.start, timeZone: 'Europe/Lisbon' }, end: { ...eventBody.end, timeZone: 'Europe/Lisbon' } });
    enqueue(eventBody);
    await run('update_event', { eventId: 'ev1', start: '2026-10-22T15:00:00-03:00' });
    expect(calls.map(c => c.method)).toEqual(['GET', 'PATCH']);
    expect(calls[1].body.start).toEqual({ dateTime: '2026-10-22T15:00:00-03:00', timeZone: 'Europe/Lisbon' });
    expect(calls[1].body.end).toEqual({ dateTime: '2026-10-22T19:30:00', timeZone: 'Europe/Lisbon' });
  });

  it('shifts an all-day event by whole days when only a new start date is given', async () => {
    enqueue({ ...eventBody, start: { date: '2026-10-20' }, end: { date: '2026-10-22' } });
    enqueue(eventBody);
    await run('update_event', { eventId: 'ev1', start: '2026-11-01' });
    expect(calls[1].body.start).toEqual({ date: '2026-11-01' });
    expect(calls[1].body.end).toEqual({ date: '2026-11-03' });
  });

  it('changes only the end when only a new end is given', async () => {
    enqueue({ ...eventBody });
    enqueue(calendarBody);
    enqueue(eventBody);
    await run('update_event', { eventId: 'ev1', end: '2026-10-20T11:00:00' });
    expect(calls[2].body).not.toHaveProperty('start');
    expect(calls[2].body.end).toEqual({ dateTime: '2026-10-20T11:00:00', timeZone: 'America/Recife' });
  });

  it('refuses to turn a timed event all-day with a lone start date', async () => {
    enqueue({ ...eventBody });
    const res = await run('update_event', { eventId: 'ev1', start: '2026-11-01' });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(1);
  });
});

describe('update_event attachments', () => {
  it('adds and removes attachments without touching the rest', async () => {
    enqueue({
      ...eventBody,
      etag: '"e1"',
      attachments: [
        { fileUrl: 'https://drive.google.com/open?id=1keep', fileId: '1keep', title: 'Keep', mimeType: 'text/plain' },
        { fileUrl: 'https://drive.google.com/open?id=1gone', fileId: '1gone', title: 'Gone' },
      ],
    });
    enqueue(eventBody);
    await run('update_event', { eventId: 'ev1', addAttachments: ['1newfile'], removeAttachments: ['1gone'] });
    expect(calls[1].method).toBe('PATCH');
    expect(calls[1].url.searchParams.get('supportsAttachments')).toBe('true');
    expect(calls[1].headers['If-Match']).toBe('"e1"');
    expect(calls[1].body.attachments).toEqual([
      { fileUrl: 'https://drive.google.com/open?id=1keep', fileId: '1keep', title: 'Keep', mimeType: 'text/plain' },
      { fileUrl: 'https://drive.google.com/open?id=1newfile' },
    ]);
  });

  it('replaces the whole attachment list when `attachments` is given', async () => {
    enqueue(eventBody);
    await run('update_event', { eventId: 'ev1', attachments: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0].body.attachments).toEqual([]);
    expect(calls[0].url.searchParams.get('supportsAttachments')).toBe('true');
  });

  it('rejects mixing a full attachment replacement with incremental changes', async () => {
    const res = await run('update_event', { eventId: 'ev1', attachments: [], addAttachments: ['1a'] });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});
