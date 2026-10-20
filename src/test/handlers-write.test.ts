import { describe, expect, it } from 'vitest';
import {
  CALENDAR,
  GET_EVENT,
  INSERT_EVENT,
  PATCH_EVENT,
  calendarBody,
  calls,
  callsTo,
  errorOf,
  eventBody,
  only,
  run,
  tool,
  stub,
  useGoogleStub,
} from './harness.js';

useGoogleStub();

describe('create_event', () => {
  it('resolves the calendar time zone for a naive start when none is given', async () => {
    stub(CALENDAR, calendarBody);
    stub(INSERT_EVENT, eventBody);
    await run('create_event', { summary: 'Sync', start: '2026-10-20T10:00:00', end: '2026-10-20T10:30:00' });
    expect(callsTo(CALENDAR)).toHaveLength(1);
    expect(only(INSERT_EVENT).body.start).toEqual({ dateTime: '2026-10-20T10:00:00', timeZone: 'America/Recife' });
  });

  it('does not look up the calendar for an all-day event or an explicit timeZone', async () => {
    stub(INSERT_EVENT, eventBody);
    await run('create_event', { summary: 'Day', start: '2026-10-20', end: '2026-10-21' });
    await run('create_event', { summary: 'Sync', start: '2026-10-20T10:00:00', end: '2026-10-20T10:30:00', timeZone: 'UTC' });
    expect(callsTo(CALENDAR)).toHaveLength(0);
    expect(callsTo(INSERT_EVENT)[1].body.start).toEqual({ dateTime: '2026-10-20T10:00:00', timeZone: 'UTC' });
  });

  it('sends the extra event options and asks Google to build the Meet link', async () => {
    stub(CALENDAR, calendarBody);
    stub(INSERT_EVENT, eventBody);
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
    const { url, body } = only(INSERT_EVENT);
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
    stub(CALENDAR, { error: { message: 'nope' } }, 500);
    const res = await run('create_event', { summary: 'Sync', start: '2026-10-20T10:00:00', end: '2026-10-20T10:30:00' });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('always names a time zone on a recurring timed event, even with offset-bearing inputs', async () => {
    stub(CALENDAR, calendarBody);
    stub(INSERT_EVENT, eventBody);
    await run('create_event', {
      summary: 'Weekly',
      start: '2026-10-20T10:00:00-03:00',
      end: '2026-10-20T10:30:00-03:00',
      recurrence: ['RRULE:FREQ=WEEKLY'],
    });
    expect(only(INSERT_EVENT).body.start).toEqual({ dateTime: '2026-10-20T10:00:00-03:00', timeZone: 'America/Recife' });
  });

  it('leaves conferenceDataVersion off when no Meet link is requested', async () => {
    stub(INSERT_EVENT, eventBody);
    await run('create_event', { summary: 'Sync', start: '2026-10-20T10:00:00Z', end: '2026-10-20T10:30:00Z' });
    const { url, body } = only(INSERT_EVENT);
    expect(url.searchParams.has('conferenceDataVersion')).toBe(false);
    expect(body).not.toHaveProperty('conferenceData');
  });

  it('refuses a range collapsed by a spring-forward gap and names the skipped local time', async () => {
    const res = await run('create_event', {
      summary: 'Gap', start: '2027-03-14T02:30:00', end: '2027-03-14T03:30:00', timeZone: 'America/New_York',
    });
    expect(res.isError).toBe(true);
    expect(errorOf(res).error).toMatch(/2027-03-14T02:30:00 does not exist in America\/New_York/);
    expect(calls).toHaveLength(0);
  });

  it('refuses an end before the start without asking Google', async () => {
    const res = await run('create_event', { summary: 'Back', start: '2026-10-20T11:00:00Z', end: '2026-10-20T10:00:00Z' });
    expect(res.isError).toBe(true);
    expect(errorOf(res).error).toMatch(/after `start`/);
    expect(calls).toHaveLength(0);
  });

  it('rejects an unknown time zone name', async () => {
    await expect(run('create_event', { summary: 'S', start: '2026-10-20T10:00:00', end: '2026-10-20T11:00:00', timeZone: 'Not/AZone' })).rejects.toThrow(/time zone/);
  });
});

describe('create_event attachments, event types and guest permissions', () => {
  it('sends attachments and tells Google the client supports them', async () => {
    stub(INSERT_EVENT, eventBody);
    await run('create_event', {
      summary: 'Sync', start: '2026-10-20T10:00:00Z', end: '2026-10-20T10:30:00Z',
      attachments: ['1abcdefghij', { fileUrl: 'https://docs.google.com/document/d/1x/edit', title: 'Notes' }],
    });
    const { url, body } = only(INSERT_EVENT);
    expect(url.searchParams.get('supportsAttachments')).toBe('true');
    expect(body.attachments).toEqual([
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
    stub('POST /calendar/v3/calendars/team%40example.com/events', { error: { message: 'Out of office events must be created on the primary calendar' } }, 400);
    const res = await run('create_event', {
      calendarId: 'team@example.com', summary: 'OOO', start: '2026-10-20T10:00:00Z', end: '2026-10-20T18:00:00Z',
      eventType: 'outOfOffice', outOfOffice: { declineMessage: 'Back Monday' },
    });
    expect(calls[0].body).toMatchObject({
      eventType: 'outOfOffice',
      transparency: 'opaque',
      outOfOfficeProperties: { autoDeclineMode: 'declineAllConflictingInvitations', declineMessage: 'Back Monday' },
    });
    expect(res.isError).toBe(true);
    const err = errorOf(res);
    expect(err.eventType).toBe('outOfOffice');
    expect(err.error).toMatch(/primary calendar/);
  });

  it('refuses a multi-day all-day working location up front', async () => {
    const res = await run('create_event', { summary: 'WFH', start: '2026-10-20', end: '2026-10-22', eventType: 'workingLocation' });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
    stub(INSERT_EVENT, eventBody);
    await run('create_event', { summary: 'WFH', start: '2026-10-20', end: '2026-10-21', eventType: 'workingLocation' });
    expect(only(INSERT_EVENT).body).toMatchObject({ eventType: 'workingLocation', visibility: 'public', transparency: 'transparent' });
  });

  it('refuses an all-day out-of-office or focus-time event up front', async () => {
    const res = await run('create_event', { summary: 'Focus', start: '2026-10-20', end: '2026-10-21', eventType: 'focusTime' });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('refuses focus time marked free, since it must block the calendar', async () => {
    const res = await run('create_event', { summary: 'Focus', start: '2026-10-20T10:00:00Z', end: '2026-10-20T12:00:00Z', eventType: 'focusTime', availability: 'free' });
    expect(res.isError).toBe(true);
    expect(errorOf(res).error).toMatch(/busy/);
    expect(calls).toHaveLength(0);
  });

  it('sends guest permissions and attendee extras', async () => {
    stub(INSERT_EVENT, { ...eventBody, attendees: [{ email: 'room@example.com', resource: true, responseStatus: 'accepted' }, { email: 'a@example.com', additionalGuests: 2 }] });
    const res = await run('create_event', {
      summary: 'Sync', start: '2026-10-20T10:00:00Z', end: '2026-10-20T10:30:00Z',
      guestPermissions: { canModify: true, canSeeOtherGuests: false },
      attendees: [{ email: 'room@example.com', resource: true }, { email: ' a@example.com ', additionalGuests: 2 }],
      sendUpdates: 'none',
    });
    const { body } = only(INSERT_EVENT);
    expect(body).toMatchObject({ guestsCanModify: true, guestsCanSeeOtherGuests: false });
    expect(body.attendees).toEqual([{ email: 'room@example.com', resource: true }, { email: 'a@example.com', additionalGuests: 2 }]);
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

describe('update_event', () => {
  it('is advertised as destructive, since it can remove guests and end a series', () => {
    expect(tool('update_event').destructiveHint).toBe(true);
  });

  it('adds and removes attendees without resetting everyone else', async () => {
    stub(GET_EVENT, {
      ...eventBody,
      etag: '"etag-1"',
      attendees: [
        { email: 'keep@example.com', responseStatus: 'accepted' },
        { email: 'gone@example.com', responseStatus: 'declined' },
      ],
    });
    stub(PATCH_EVENT, eventBody);
    await run('update_event', {
      eventId: 'ev1',
      addAttendees: ['new@example.com'],
      removeAttendees: [' Gone@example.com '],
      sendUpdates: 'none',
    });
    const patch = only(PATCH_EVENT);
    expect(patch.headers['If-Match']).toBe('"etag-1"');
    expect(patch.body.attendees).toEqual([
      { email: 'keep@example.com', responseStatus: 'accepted' },
      { email: 'new@example.com' },
    ]);
  });

  it('refuses to remove someone who is not a guest instead of reporting a silent success', async () => {
    stub(GET_EVENT, { ...eventBody, attendees: [{ email: 'keep@example.com' }] });
    const res = await run('update_event', { eventId: 'ev1', removeAttendees: ['nobody@example.com'] });
    expect(res.isError).toBe(true);
    expect(errorOf(res).error).toMatch(/nobody@example.com/);
    expect(callsTo(PATCH_EVENT)).toHaveLength(0);
  });

  it('reports a concurrent edit instead of overwriting it when the guest list changed underneath', async () => {
    stub(GET_EVENT, { ...eventBody, etag: '"etag-1"', attendees: [] });
    stub(PATCH_EVENT, { error: { message: 'Precondition Failed' } }, 412);
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
    stub(GET_EVENT, { ...eventBody, attendees: [], attendeesOmitted: true });
    const res = await run('update_event', { eventId: 'ev1', addAttendees: ['b@example.com'] });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('patches event options and a Meet link request without reading the event first', async () => {
    stub(PATCH_EVENT, eventBody);
    await run('update_event', { eventId: 'ev1', colorId: '2', addGoogleMeet: true });
    const { url, body } = only(PATCH_EVENT);
    expect(calls).toHaveLength(1);
    expect(url.searchParams.get('conferenceDataVersion')).toBe('1');
    expect(body).toMatchObject({ colorId: '2' });
    expect(body.conferenceData.createRequest.conferenceSolutionKey).toEqual({ type: 'hangoutsMeet' });
  });

  it('re-sends the stored times with a named zone when making an offset-only event recurring', async () => {
    stub(GET_EVENT, { ...eventBody, etag: '"e"' });
    stub(CALENDAR, calendarBody);
    stub(PATCH_EVENT, eventBody);
    await run('update_event', { eventId: 'ev1', recurrence: ['RRULE:FREQ=WEEKLY'] });
    expect(calls).toHaveLength(3);
    expect(only(PATCH_EVENT).body).toMatchObject({
      recurrence: ['RRULE:FREQ=WEEKLY'],
      start: { dateTime: '2026-10-20T10:00:00-03:00', timeZone: 'America/Recife' },
      end: { dateTime: '2026-10-20T10:30:00-03:00', timeZone: 'America/Recife' },
    });
  });

  it('leaves the times alone when the event already stores a named zone', async () => {
    stub(GET_EVENT, {
      ...eventBody,
      start: { ...eventBody.start, timeZone: 'Europe/Lisbon' },
      end: { ...eventBody.end, timeZone: 'Europe/Lisbon' },
    });
    stub(PATCH_EVENT, eventBody);
    await run('update_event', { eventId: 'ev1', recurrence: ['RRULE:FREQ=WEEKLY'] });
    expect(calls).toHaveLength(2);
    expect(only(PATCH_EVENT).body).not.toHaveProperty('start');
  });

  it('resolves the calendar time zone for naive reschedules when none is given', async () => {
    stub(GET_EVENT, eventBody);
    stub(CALENDAR, calendarBody);
    stub(PATCH_EVENT, eventBody);
    await run('update_event', { eventId: 'ev1', start: '2026-10-20T15:00:00', end: '2026-10-20T16:00:00' });
    expect(only(PATCH_EVENT).body.end).toEqual({ dateTime: '2026-10-20T16:00:00', timeZone: 'America/Recife', date: null });
  });

  it('keeps the stored zone of an existing series when both bounds are moved with offsets', async () => {
    stub(GET_EVENT, {
      ...eventBody,
      recurrence: ['RRULE:FREQ=WEEKLY'],
      start: { ...eventBody.start, timeZone: 'Europe/Lisbon' },
      end: { ...eventBody.end, timeZone: 'Europe/Lisbon' },
    });
    stub(PATCH_EVENT, eventBody);
    await run('update_event', { eventId: 'ev1', start: '2026-10-21T10:00:00-03:00', end: '2026-10-21T11:00:00-03:00' });
    expect(callsTo(CALENDAR)).toHaveLength(0);
    const { body } = only(PATCH_EVENT);
    expect(body.start).toEqual({ dateTime: '2026-10-21T10:00:00-03:00', timeZone: 'Europe/Lisbon', date: null });
    expect(body.end).toEqual({ dateTime: '2026-10-21T11:00:00-03:00', timeZone: 'Europe/Lisbon', date: null });
  });

  it('names the calendar zone for a series moved with offsets when the event stores none', async () => {
    stub(GET_EVENT, { ...eventBody, recurrence: ['RRULE:FREQ=WEEKLY'] });
    stub(CALENDAR, calendarBody);
    stub(PATCH_EVENT, eventBody);
    await run('update_event', { eventId: 'ev1', start: '2026-10-21T10:00:00-03:00', end: '2026-10-21T11:00:00-03:00' });
    expect(only(PATCH_EVENT).body.start.timeZone).toBe('America/Recife');
  });

  it('switches a timed event to all-day by clearing the stored time fields', async () => {
    stub(GET_EVENT, { ...eventBody, start: { ...eventBody.start, timeZone: 'America/Recife' } });
    stub(PATCH_EVENT, eventBody);
    await run('update_event', { eventId: 'ev1', start: '2026-11-05', end: '2026-11-06' });
    const { body } = only(PATCH_EVENT);
    expect(body.start).toEqual({ date: '2026-11-05', dateTime: null, timeZone: null });
    expect(body.end).toEqual({ date: '2026-11-06', dateTime: null, timeZone: null });
  });

  it('switches an all-day event to timed by clearing the stored date', async () => {
    stub(GET_EVENT, { ...eventBody, start: { date: '2026-11-05' }, end: { date: '2026-11-06' } });
    stub(PATCH_EVENT, eventBody);
    await run('update_event', { eventId: 'ev1', start: '2026-11-05T10:00:00Z', end: '2026-11-05T11:00:00Z' });
    const { body } = only(PATCH_EVENT);
    expect(body.start).toEqual({ dateTime: '2026-11-05T10:00:00Z', date: null });
    expect(body.end).toEqual({ dateTime: '2026-11-05T11:00:00Z', date: null });
  });

  it('refuses to make a focus-time event all-day, using the stored event type', async () => {
    stub(GET_EVENT, { ...eventBody, eventType: 'focusTime' });
    const res = await run('update_event', { eventId: 'ev1', start: '2026-11-05', end: '2026-11-06' });
    expect(res.isError).toBe(true);
    expect(errorOf(res)).toMatchObject({ eventType: 'focusTime' });
    expect(callsTo(PATCH_EVENT)).toHaveLength(0);
  });

  it('refuses both bounds collapsed by a spring-forward gap', async () => {
    stub(GET_EVENT, eventBody);
    const res = await run('update_event', {
      eventId: 'ev1', start: '2027-03-14T02:30:00', end: '2027-03-14T03:30:00', timeZone: 'America/New_York',
    });
    expect(res.isError).toBe(true);
    expect(errorOf(res).error).toMatch(/does not exist in America\/New_York/);
    expect(callsTo(PATCH_EVENT)).toHaveLength(0);
  });
});

describe('update_event attachments', () => {
  it('adds and removes attachments without touching the rest', async () => {
    stub(GET_EVENT, {
      ...eventBody,
      etag: '"e1"',
      attachments: [
        { fileUrl: 'https://drive.google.com/open?id=1keep', fileId: '1keep', title: 'Keep', mimeType: 'text/plain' },
        { fileUrl: 'https://drive.google.com/open?id=1gone', fileId: '1gone', title: 'Gone' },
      ],
    });
    stub(PATCH_EVENT, eventBody);
    await run('update_event', { eventId: 'ev1', addAttachments: ['1newfile'], removeAttachments: [' 1gone '] });
    const patch = only(PATCH_EVENT);
    expect(patch.url.searchParams.get('supportsAttachments')).toBe('true');
    expect(patch.headers['If-Match']).toBe('"e1"');
    expect(patch.body.attachments).toEqual([
      { fileUrl: 'https://drive.google.com/open?id=1keep', fileId: '1keep', title: 'Keep', mimeType: 'text/plain' },
      { fileUrl: 'https://drive.google.com/open?id=1newfile' },
    ]);
  });

  it('refuses to remove an attachment the event does not have', async () => {
    stub(GET_EVENT, { ...eventBody, attachments: [] });
    const res = await run('update_event', { eventId: 'ev1', removeAttachments: ['1missing'] });
    expect(res.isError).toBe(true);
    expect(callsTo(PATCH_EVENT)).toHaveLength(0);
  });

  it('replaces the whole attachment list when `attachments` is given', async () => {
    stub(PATCH_EVENT, eventBody);
    await run('update_event', { eventId: 'ev1', attachments: [] });
    const patch = only(PATCH_EVENT);
    expect(calls).toHaveLength(1);
    expect(patch.body.attachments).toEqual([]);
    expect(patch.url.searchParams.get('supportsAttachments')).toBe('true');
  });

  it('rejects mixing a full attachment replacement with incremental changes', async () => {
    const res = await run('update_event', { eventId: 'ev1', attachments: [], addAttachments: ['1a'] });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe('respond_to_event', () => {
  const invited = {
    ...eventBody,
    etag: '"r1"',
    attendees: [
      { email: 'org@example.com', organizer: true, responseStatus: 'accepted' },
      { email: 'me@example.com', self: true, responseStatus: 'needsAction' },
    ],
  };

  it('changes only your own entry and returns the event with your stored response', async () => {
    stub(GET_EVENT, invited);
    stub(PATCH_EVENT, { ...invited, attendees: [invited.attendees[0], { ...invited.attendees[1], responseStatus: 'accepted', comment: 'See you' }] });
    const res = await run('respond_to_event', { eventId: 'ev1', responseStatus: 'accepted', comment: 'See you' });
    const patch = only(PATCH_EVENT);
    expect(patch.headers['If-Match']).toBe('"r1"');
    expect(patch.body.attendees).toEqual([
      invited.attendees[0],
      { ...invited.attendees[1], responseStatus: 'accepted', comment: 'See you' },
    ]);
    expect(res.structuredContent).toMatchObject({
      id: 'ev1',
      summary: 'Sync',
      myResponseStatus: 'accepted',
      myComment: 'See you',
      message: 'Your response to "Sync" was set to accepted.',
    });
    expect(res.structuredContent.attendees[1]).toEqual({ email: 'me@example.com', responseStatus: 'accepted', self: true });
  });

  it('retries once on a concurrent edit, then gives up without overwriting', async () => {
    stub(GET_EVENT, invited);
    stub(PATCH_EVENT, { error: { message: 'Precondition Failed' } }, 412);
    const res = await run('respond_to_event', { eventId: 'ev1', responseStatus: 'declined' });
    expect(callsTo(GET_EVENT)).toHaveLength(2);
    expect(callsTo(PATCH_EVENT)).toHaveLength(2);
    expect(res.isError).toBe(true);
    expect(errorOf(res).error).toMatch(/being changed by someone else/);
  });

  it('sends nothing when the response is already what was asked', async () => {
    stub(GET_EVENT, { ...invited, attendees: [{ email: 'me@example.com', self: true, responseStatus: 'tentative' }] });
    const res = await run('respond_to_event', { eventId: 'ev1', responseStatus: 'tentative' });
    expect(callsTo(PATCH_EVENT)).toHaveLength(0);
    expect(res.structuredContent.message).toMatch(/already tentative/);
  });

  it('identifies you by your primary calendar address on a shared calendar', async () => {
    const shared = 'GET /calendar/v3/calendars/team%40example.com/events/ev1';
    stub(CALENDAR, calendarBody);
    stub(shared, { ...invited, attendees: [{ email: 'owner@example.com', self: true }, { email: 'Joao@Example.com', responseStatus: 'needsAction' }] });
    stub('PATCH /calendar/v3/calendars/team%40example.com/events/ev1', invited);
    await run('respond_to_event', { calendarId: 'team@example.com', eventId: 'ev1', responseStatus: 'accepted', sendUpdates: 'none' });
    expect(callsTo(CALENDAR)).toHaveLength(1);
    expect(calls.at(-1)!.body.attendees).toEqual([
      { email: 'owner@example.com', self: true },
      { email: 'Joao@Example.com', responseStatus: 'accepted' },
    ]);
  });

  it('refuses to guess on a shared calendar when your address cannot be read', async () => {
    stub(CALENDAR, { error: { message: 'nope' } }, 403);
    stub('GET /calendar/v3/calendars/team%40example.com/events/ev1', invited);
    const res = await run('respond_to_event', { calendarId: 'team@example.com', eventId: 'ev1', responseStatus: 'accepted' });
    expect(res.isError).toBe(true);
    expect(errorOf(res).error).toMatch(/email address could not be determined/);
  });
});
