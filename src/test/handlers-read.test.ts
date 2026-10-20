import { describe, expect, it } from 'vitest';
import { NOT_CONNECTED_MESSAGE } from '../auth.js';
import {
  CALENDAR,
  FREE_BUSY,
  GET_EVENT,
  LIST_EVENTS,
  calendarBody,
  calls,
  callsTo,
  errorOf,
  expectInvalid,
  eventBody,
  only,
  run,
  stub,
  tool,
  useGoogleStub,
} from './harness.js';

useGoogleStub();

describe('tool handlers', () => {
  it('answer without an access token with the not-connected result and no Google call', async () => {
    const res = await tool('list_calendars').handler({});
    expect(res.isError).toBe(true);
    expect(errorOf(res as { content: Array<{ text: string }> })).toEqual({ error: NOT_CONNECTED_MESSAGE, status: 401 });
    expect(calls).toHaveLength(0);
  });
});

describe('get_calendar_events', () => {
  it('forwards a free-text query and keeps the default lower bound so upcoming matches come first', async () => {
    stub(LIST_EVENTS, { items: [] });
    await run('get_calendar_events', { q: 'budget review' });
    const { url } = only(LIST_EVENTS);
    expect(calls).toHaveLength(1);
    expect(url.searchParams.get('q')).toBe('budget review');
    expect(url.searchParams.get('timeMin')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(url.searchParams.has('timeZone')).toBe(false);
  });

  it('trims the query and rejects one that is only whitespace', async () => {
    stub(LIST_EVENTS, { items: [] });
    await run('get_calendar_events', { q: '  budget review  ' });
    expect(only(LIST_EVENTS).url.searchParams.get('q')).toBe('budget review');
    expectInvalid(await run('get_calendar_events', { q: '   ' }));
  });

  it('keeps the page token when Google returns an empty page with more results behind it', async () => {
    stub(LIST_EVENTS, { items: [], nextPageToken: 'next' });
    const res = await run('get_calendar_events', { q: 'offsite' });
    expect(res.structuredContent.nextPageToken).toMatch(/^gcalpage1\./);
    expect(res.structuredContent.message).toContain('pageToken');
  });

  it('interprets naive bounds in the calendar time zone when no timeZone is given', async () => {
    stub(CALENDAR, calendarBody);
    stub(LIST_EVENTS, { items: [] });
    await run('get_calendar_events', { timeMin: '2026-10-20', timeMax: '2026-10-21T12:00:00' });
    expect(callsTo(CALENDAR)).toHaveLength(1);
    const { url } = only(LIST_EVENTS);
    expect(url.searchParams.get('timeMin')).toBe('2026-10-20T00:00:00-03:00');
    expect(url.searchParams.get('timeMax')).toBe('2026-10-21T12:00:00-03:00');
    expect(url.searchParams.has('timeZone')).toBe(false);
  });

  it('does not look up the calendar when the bounds carry their own offset', async () => {
    stub(LIST_EVENTS, { items: [] });
    await run('get_calendar_events', { timeMin: '2026-10-20T00:00:00Z' });
    expect(calls).toHaveLength(1);
  });

  it('reports the calendar lookup failure instead of guessing UTC', async () => {
    stub(CALENDAR, { error: { message: 'nope' } }, 403);
    const res = await run('get_calendar_events', { timeMin: '2026-10-20' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('time zone');
    expect(calls).toHaveLength(1);
  });

  it('rejects an unknown time zone name instead of falling back to the calendar zone', async () => {
    expectInvalid(await run('get_calendar_events', { timeZone: 'Not/AZone' }), /time zone/);
    expectInvalid(await run('get_event', { eventId: 'ev1', timeZone: 'Not/AZone' }), /time zone/);
    expectInvalid(await run('get_next_availability', { duration: 30, timezone: 'Not/AZone' }), /time zone/);
    expect(calls).toHaveLength(0);
  });

  it('rejects page sizes outside the documented ranges', async () => {
    expectInvalid(await run('get_calendar_events', { maxResults: -5 }));
    expectInvalid(await run('get_calendar_events', { maxResults: 2501 }));
    expectInvalid(await run('list_calendars', { maxResults: 0 }));
    expectInvalid(await run('list_calendars', { maxResults: 251 }));
  });

  it('exposes organizer, rich attendees and event flags in the output', async () => {
    stub(LIST_EVENTS, {
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
    stub(LIST_EVENTS, { items: [eventBody] });
    const res = await run('get_calendar_events', { timeMin: '2026-10-20T00:00:00Z' });
    const ev = res.structuredContent.events[0];
    expect(ev.availability).toBe('busy');
    expect(ev).not.toHaveProperty('organizer');
    expect(ev).not.toHaveProperty('colorId');
    expect(ev).not.toHaveProperty('reminders');
  });
});

describe('get_calendar_events filters and ordering', () => {
  it('forwards event type filters, showDeleted and ordering by last update', async () => {
    stub(LIST_EVENTS, { items: [] });
    await run('get_calendar_events', { eventTypes: ['outOfOffice', 'focusTime'], showDeleted: true, orderBy: 'updated', timeMin: '2026-10-20T00:00:00Z' });
    const p = only(LIST_EVENTS).url.searchParams;
    expect(p.getAll('eventTypes')).toEqual(['outOfOffice', 'focusTime']);
    expect(p.get('showDeleted')).toBe('true');
    expect(p.get('orderBy')).toBe('updated');
    expect(p.get('singleEvents')).toBe('true');
  });

  it('orders by start time and leaves the other filters off by default', async () => {
    stub(LIST_EVENTS, { items: [] });
    await run('get_calendar_events', { timeMin: '2026-10-20T00:00:00Z' });
    const p = only(LIST_EVENTS).url.searchParams;
    expect(p.get('orderBy')).toBe('startTime');
    expect(p.has('eventTypes')).toBe(false);
    expect(p.has('showDeleted')).toBe(false);
  });

  it('returns series masters instead of instances when asked not to expand recurring events', async () => {
    stub(LIST_EVENTS, { items: [] });
    await run('get_calendar_events', { expandRecurring: false, timeMin: '2026-10-20T00:00:00Z' });
    const p = only(LIST_EVENTS).url.searchParams;
    expect(p.get('singleEvents')).toBe('false');
    expect(p.has('orderBy')).toBe(false);
  });

  it('refuses start-time ordering of unexpanded series, which Google cannot do', async () => {
    const res = await run('get_calendar_events', { expandRecurring: false, orderBy: 'startTime' });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('exposes attachments, guest permissions and event type settings in the output', async () => {
    stub(LIST_EVENTS, {
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

  it('exposes birthday details in the output', async () => {
    stub(LIST_EVENTS, { items: [{ ...eventBody, eventType: 'birthday', birthdayProperties: { type: 'birthday', contact: 'people/c1' } }] });
    const res = await run('get_calendar_events', { timeMin: '2026-10-20T00:00:00Z', eventTypes: ['birthday'] });
    expect(res.structuredContent.events[0].birthday).toEqual({ type: 'birthday', contact: 'people/c1' });
  });
});

describe('get_calendar_events pagination', () => {
  it('keeps the implicit "now" in the page token so the next page continues from the same bound', async () => {
    stub(LIST_EVENTS, { items: [eventBody], nextPageToken: 'g-token' });
    stub(LIST_EVENTS, { items: [] });
    const first = await run('get_calendar_events', { q: 'sync' });
    const token = first.structuredContent.nextPageToken;
    expect(token).not.toBe('g-token');

    await run('get_calendar_events', { q: 'sync', pageToken: token });
    const [firstCall, secondCall] = callsTo(LIST_EVENTS);
    expect(secondCall.url.searchParams.get('pageToken')).toBe('g-token');
    expect(secondCall.url.searchParams.get('timeMin')).toBe(firstCall.url.searchParams.get('timeMin'));
  });

  it('carries resolved explicit bounds too, so later pages need no time zone lookup', async () => {
    stub(CALENDAR, calendarBody);
    stub(LIST_EVENTS, { items: [eventBody], nextPageToken: 'g-token' });
    stub(LIST_EVENTS, { items: [] });
    const args = { timeMin: '2026-10-20', timeMax: '2026-10-21' };
    const first = await run('get_calendar_events', args);
    await run('get_calendar_events', { ...args, pageToken: first.structuredContent.nextPageToken });
    expect(callsTo(CALENDAR)).toHaveLength(1);
    const second = callsTo(LIST_EVENTS)[1].url.searchParams;
    expect(second.get('timeMin')).toBe('2026-10-20T00:00:00-03:00');
    expect(second.get('timeMax')).toBe('2026-10-21T00:00:00-03:00');
  });

  it('rejects a token combined with different bounds, since Google needs identical bounds per page', async () => {
    stub(LIST_EVENTS, { items: [eventBody], nextPageToken: 'g-token' });
    const first = await run('get_calendar_events', {});
    const res = await run('get_calendar_events', { pageToken: first.structuredContent.nextPageToken, timeMin: '2026-10-20T00:00:00Z' });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('treats showDeleted false and omitted as the same listing when continuing', async () => {
    stub(LIST_EVENTS, { items: [eventBody], nextPageToken: 'g-token' });
    stub(LIST_EVENTS, { items: [] });
    const first = await run('get_calendar_events', { timeMin: '2026-10-20T00:00:00Z', showDeleted: false });
    const res = await run('get_calendar_events', { timeMin: '2026-10-20T00:00:00Z', pageToken: first.structuredContent.nextPageToken });
    expect(res.isError).toBeUndefined();
    expect(callsTo(LIST_EVENTS)[1].url.searchParams.get('pageToken')).toBe('g-token');
    expect(callsTo(LIST_EVENTS)[1].url.searchParams.has('showDeleted')).toBe(false);
  });

  it('rejects a token reused with a different query instead of returning an empty page', async () => {
    stub(LIST_EVENTS, { items: [eventBody], nextPageToken: 'g-token' });
    const first = await run('get_calendar_events', { q: 'sync' });
    const res = await run('get_calendar_events', { q: 'offsite', pageToken: first.structuredContent.nextPageToken });
    expect(res.isError).toBe(true);
    expect(errorOf(res).error).toMatch(/different listing/);
    expect(calls).toHaveLength(1);
  });
});

describe('get_event', () => {
  it('lets Google format times in the calendar time zone when none is given', async () => {
    stub(GET_EVENT, eventBody);
    await run('get_event', { eventId: 'ev1' });
    expect(only(GET_EVENT).url.searchParams.has('timeZone')).toBe(false);
  });

  it('forwards an explicit time zone and reports a response with no id', async () => {
    stub(GET_EVENT, {});
    const res = await run('get_event', { eventId: 'ev1', timeZone: 'Europe/Lisbon' });
    expect(only(GET_EVENT).url.searchParams.get('timeZone')).toBe('Europe/Lisbon');
    expect(res.isError).toBe(true);
    expect(errorOf(res).error).toMatch(/no event id/);
  });
});

describe('get_next_availability', () => {
  const day = (h: number) => `2026-10-20T${String(h).padStart(2, '0')}:00:00Z`;

  it('unions busy time across every requested calendar', async () => {
    stub(FREE_BUSY, {
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
    expect(only(FREE_BUSY).body.items).toEqual([{ id: 'primary' }, { id: 'bob@example.com' }]);
    expect(res.structuredContent.calendarIds).toEqual(['primary', 'bob@example.com']);
    expect(res.structuredContent.availableSlots[0].start.time).toBe('11:00:00');
  });

  it('offers slots on local hour and half-hour boundaries in zones with uneven offsets', async () => {
    stub(FREE_BUSY, { calendars: { primary: { busy: [] } } });
    const kolkata = await run('get_next_availability', {
      duration: 60, timezone: 'Asia/Kolkata', startFrom: '2026-10-20T09:10:00', startTimeIncrement: 60, maxResults: 3,
    });
    expect(kolkata.structuredContent.availableSlots.map((s: any) => s.start.time)).toEqual(['10:00:00', '11:00:00', '12:00:00']);
    const kathmandu = await run('get_next_availability', {
      duration: 30, timezone: 'Asia/Kathmandu', startFrom: '2026-10-20T09:10:00', maxResults: 3,
    });
    expect(kathmandu.structuredContent.availableSlots.map((s: any) => s.start.time)).toEqual(['09:30:00', '10:00:00', '10:30:00']);
  });

  it('steps a 45-minute grid from local midnight, starts after startFrom and pages from the next candidate', async () => {
    stub(FREE_BUSY, { calendars: { primary: { busy: [] } } });
    const res = await run('get_next_availability', {
      duration: 30, timezone: 'UTC', startFrom: '2026-10-20T09:00:30Z', startTimeIncrement: 45, maxResults: 3,
    });
    expect(res.structuredContent.availableSlots.map((s: any) => s.start.time)).toEqual(['09:45:00', '10:30:00', '11:15:00']);
    expect(res.structuredContent.searchedUntil).toBe('2026-10-20T12:00:00');
    expect(res.structuredContent.exhausted).toBe(false);
  });

  it('falls back to the calendar time zone when none is given', async () => {
    stub(CALENDAR, calendarBody);
    stub(FREE_BUSY, { calendars: { primary: { busy: [] } } });
    const res = await run('get_next_availability', {
      duration: 30,
      startFrom: '2026-10-20T09:00:00',
      maxResults: 1,
    });
    expect(callsTo(CALENDAR)).toHaveLength(1);
    const { body } = only(FREE_BUSY);
    expect(body.timeZone).toBe('America/Recife');
    expect(body.timeMin).toBe('2026-10-20T12:00:00.000Z');
    expect(res.structuredContent.availableSlots[0].start).toEqual({ date: '2026-10-20', time: '09:00:00', dayOfWeek: 'Tue' });
  });

  it('reports the calendar lookup failure instead of guessing a time zone', async () => {
    stub(CALENDAR, { error: { message: 'nope' } }, 403);
    const res = await run('get_next_availability', { duration: 30 });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('time zone');
    expect(calls).toHaveLength(1);
  });

  it('rejects an unparseable startFrom before calling Google', async () => {
    const res = await run('get_next_availability', { duration: 30, startFrom: '2026-13-45T10:00:00' });
    expect(res.isError).toBe(true);
    expect(errorOf(res).error).toMatch(/startFrom/);
    expect(calls).toHaveLength(0);
  });

  it('rejects more calendars than one free/busy query can hold', async () => {
    expectInvalid(await run('get_next_availability', {
      duration: 30,
      timezone: 'UTC',
      calendarIds: Array.from({ length: 50 }, (_, i) => `p${i}@example.com`),
    }));
  });

  it('names the calendar that failed in a multi-calendar lookup', async () => {
    stub(FREE_BUSY, {
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
