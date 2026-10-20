import { describe, expect, it } from 'vitest';
import {
  CALENDAR,
  GET_EVENT,
  PATCH_EVENT,
  calendarBody,
  calls,
  callsTo,
  errorOf,
  eventBody,
  only,
  run,
  stub,
  useGoogleStub,
} from './harness.js';

useGoogleStub();

describe('update_event reschedule with one bound', () => {
  it('moves the start and keeps the duration when only a new start is given, guarded by the etag it read', async () => {
    stub(GET_EVENT, { ...eventBody, etag: '"e9"' });
    stub(CALENDAR, calendarBody);
    stub(PATCH_EVENT, eventBody);
    await run('update_event', { eventId: 'ev1', start: '2026-10-22T15:00:00' });
    const patch = only(PATCH_EVENT);
    expect(patch.headers['If-Match']).toBe('"e9"');
    expect(patch.body.start).toEqual({ dateTime: '2026-10-22T15:00:00', timeZone: 'America/Recife', date: null });
    expect(patch.body.end).toEqual({ dateTime: '2026-10-22T15:30:00-03:00', timeZone: 'America/Recife', date: null });
  });

  it('keeps a new end when making an offset-only event recurring in the same call', async () => {
    stub(GET_EVENT, eventBody);
    stub(CALENDAR, calendarBody);
    stub(PATCH_EVENT, eventBody);
    await run('update_event', { eventId: 'ev1', end: '2026-10-20T11:00:00-03:00', recurrence: ['RRULE:FREQ=WEEKLY'] });
    const { body } = only(PATCH_EVENT);
    expect(body.start).toMatchObject({ dateTime: '2026-10-20T10:00:00-03:00', timeZone: 'America/Recife' });
    expect(body.end).toMatchObject({ dateTime: '2026-10-20T11:00:00-03:00', timeZone: 'America/Recife' });
  });

  it('uses the zone the event already stores for a start-only move', async () => {
    stub(GET_EVENT, { ...eventBody, start: { ...eventBody.start, timeZone: 'Europe/Lisbon' }, end: { ...eventBody.end, timeZone: 'Europe/Lisbon' } });
    stub(PATCH_EVENT, eventBody);
    await run('update_event', { eventId: 'ev1', start: '2026-10-22T15:00:00-03:00' });
    expect(calls).toHaveLength(2);
    const { body } = only(PATCH_EVENT);
    expect(body.start).toMatchObject({ dateTime: '2026-10-22T15:00:00-03:00', timeZone: 'Europe/Lisbon' });
    expect(body.end).toMatchObject({ dateTime: '2026-10-22T19:30:00+01:00', timeZone: 'Europe/Lisbon' });
  });

  it('rejects a start-only move whose derived end lands on the second pass of a repeated hour, without patching', async () => {
    const ny = { start: { dateTime: '2026-10-30T09:00:00-04:00', timeZone: 'America/New_York' }, end: { dateTime: '2026-10-30T10:30:00-04:00', timeZone: 'America/New_York' } };
    stub(GET_EVENT, { ...eventBody, ...ny });
    const res = await run('update_event', { eventId: 'ev1', start: '2026-11-01T00:30:00-04:00' });
    expect(errorOf(res).error).toMatch(/2026-11-01T01:00:00-05:00 .* falls in the second pass.*outside the repeated hour/);
    expect(callsTo(PATCH_EVENT)).toHaveLength(0);
  });

  it('rejects relabelling an event into a zone where it would sit on the second pass of a repeated hour', async () => {
    stub(GET_EVENT, { ...eventBody, start: { dateTime: '2026-11-01T06:30:00Z' }, end: { dateTime: '2026-11-01T07:30:00Z' } });
    const res = await run('update_event', { eventId: 'ev1', timeZone: 'America/New_York' });
    expect(errorOf(res).error).toMatch(/falls in the second pass/);
    expect(callsTo(PATCH_EVENT)).toHaveLength(0);
  });

  it('shifts an all-day event by whole days when only a new start date is given', async () => {
    stub(GET_EVENT, { ...eventBody, start: { date: '2026-10-20' }, end: { date: '2026-10-22' } });
    stub(PATCH_EVENT, eventBody);
    await run('update_event', { eventId: 'ev1', start: '2026-11-01' });
    const { body } = only(PATCH_EVENT);
    expect(body.start).toMatchObject({ date: '2026-11-01' });
    expect(body.end).toMatchObject({ date: '2026-11-03' });
  });

  it('changes only the end when only a new end is given', async () => {
    stub(GET_EVENT, eventBody);
    stub(CALENDAR, calendarBody);
    stub(PATCH_EVENT, eventBody);
    await run('update_event', { eventId: 'ev1', end: '2026-10-20T11:00:00' });
    const { body } = only(PATCH_EVENT);
    expect(body.start).toEqual({ dateTime: '2026-10-20T10:00:00-03:00', date: null });
    expect(body.end).toEqual({ dateTime: '2026-10-20T11:00:00', timeZone: 'America/Recife', date: null });
  });

  it('refuses an end that lands on the start because its local time was skipped', async () => {
    stub(CALENDAR, { ...calendarBody, timeZone: 'America/New_York' });
    stub(GET_EVENT, {
      ...eventBody,
      start: { dateTime: '2027-03-14T03:30:00-04:00', timeZone: 'America/New_York' },
      end: { dateTime: '2027-03-14T04:00:00-04:00', timeZone: 'America/New_York' },
    });
    const res = await run('update_event', { eventId: 'ev1', end: '2027-03-14T02:30:00' });
    expect(res.isError).toBe(true);
    expect(errorOf(res).error).toMatch(/2027-03-14T02:30:00 does not exist/);
    expect(callsTo(PATCH_EVENT)).toHaveLength(0);
  });

  it('refuses to turn a timed event all-day with a lone start date', async () => {
    stub(GET_EVENT, eventBody);
    const res = await run('update_event', { eventId: 'ev1', start: '2026-11-01' });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(1);
  });
});


describe('update_event time zones', () => {
  const newYork = {
    ...eventBody,
    start: { dateTime: '2026-10-20T10:00:00-04:00', timeZone: 'America/New_York' },
    end: { dateTime: '2026-10-20T11:00:00-04:00', timeZone: 'America/New_York' },
  };
  const instant = (time: { dateTime: string }) => Date.parse(time.dateTime);

  async function patchFor(args: Record<string, unknown>, event: Record<string, unknown> = newYork) {
    stub(GET_EVENT, event);
    stub(CALENDAR, calendarBody);
    stub(PATCH_EVENT, eventBody);
    await run('update_event', { eventId: 'ev1', ...args });
    const body = callsTo(PATCH_EVENT).at(-1)!.body;
    return body;
  }

  it('reads the same naive time in the calendar zone whether one or both bounds are given', async () => {
    const range = await patchFor({ start: '2026-10-22T15:00:00', end: '2026-10-22T16:00:00' });
    const startOnly = await patchFor({ start: '2026-10-22T15:00:00' });
    const endOnly = await patchFor({ end: '2026-10-22T16:00:00' });
    const at = (iso: string) => Date.parse(iso);
    expect(instant(range.start)).toBe(at('2026-10-22T15:00:00-03:00'));
    expect(instant(startOnly.start)).toBe(at('2026-10-22T15:00:00-03:00'));
    expect(instant(range.end)).toBe(at('2026-10-22T16:00:00-03:00'));
    expect(instant(endOnly.end)).toBe(at('2026-10-22T16:00:00-03:00'));
    for (const body of [range, startOnly, endOnly]) {
      expect(body.start.timeZone).toBe('America/New_York');
      expect(body.end.timeZone).toBe('America/New_York');
    }
  });

  it('keeps a different zone on each endpoint when only one of them moves', async () => {
    const flight = {
      ...eventBody,
      start: { dateTime: '2026-10-20T18:00:00-04:00', timeZone: 'America/New_York' },
      end: { dateTime: '2026-10-21T06:00:00+01:00', timeZone: 'Europe/London' },
    };
    const endOnly = await patchFor({ end: '2026-10-21T07:00:00', timeZone: 'Europe/London' }, flight);
    expect(endOnly.start).toEqual({ dateTime: '2026-10-20T18:00:00-04:00', timeZone: 'America/New_York', date: null });
    expect(endOnly.end).toEqual({ dateTime: '2026-10-21T07:00:00', timeZone: 'Europe/London', date: null });

    const startOnly = await patchFor({ start: '2026-10-20T19:00:00-04:00' }, flight);
    expect(startOnly.start).toEqual({ dateTime: '2026-10-20T19:00:00-04:00', timeZone: 'America/New_York', date: null });
    expect(startOnly.end).toEqual({ dateTime: '2026-10-21T07:00:00+01:00', timeZone: 'Europe/London', date: null });
  });

  it('keeps the series zone when a naive time is given on a calendar in another zone', async () => {
    const body = await patchFor({ end: '2026-10-20T13:00:00' }, { ...newYork, recurrence: ['RRULE:FREQ=WEEKLY'] });
    expect(body.start).toEqual({ dateTime: '2026-10-20T10:00:00-04:00', timeZone: 'America/New_York', date: null });
    expect(body.end).toEqual({ dateTime: '2026-10-20T13:00:00-03:00', timeZone: 'America/New_York', date: null });
  });

  it('names one zone on both ends of a series moved with an explicit time zone', async () => {
    const body = await patchFor({ end: '2026-10-20T16:00:00', timeZone: 'Europe/Lisbon' }, { ...newYork, recurrence: ['RRULE:FREQ=WEEKLY'] });
    expect(body.start).toMatchObject({ dateTime: '2026-10-20T10:00:00-04:00', timeZone: 'Europe/Lisbon' });
    expect(body.end).toMatchObject({ dateTime: '2026-10-20T16:00:00', timeZone: 'Europe/Lisbon' });
  });

  it('moves a timed event into a time zone passed alone, keeping its instants', async () => {
    const flight = { ...newYork, end: { dateTime: '2026-10-21T06:00:00+01:00', timeZone: 'Europe/London' } };
    const body = await patchFor({ timeZone: 'Asia/Tokyo' }, flight);
    expect(body.start).toEqual({ dateTime: '2026-10-20T10:00:00-04:00', timeZone: 'Asia/Tokyo', date: null });
    expect(body.end).toEqual({ dateTime: '2026-10-21T06:00:00+01:00', timeZone: 'Asia/Tokyo', date: null });
  });

  it('moves a whole series into one time zone passed alone', async () => {
    const body = await patchFor({ timeZone: 'Europe/London' }, { ...newYork, recurrence: ['RRULE:FREQ=WEEKLY'] });
    expect(body.start).toEqual({ dateTime: '2026-10-20T10:00:00-04:00', timeZone: 'Europe/London', date: null });
    expect(body.end).toEqual({ dateTime: '2026-10-20T11:00:00-04:00', timeZone: 'Europe/London', date: null });
  });

  it('moves a flight-style event into its start zone when it becomes recurring', async () => {
    const flight = {
      ...eventBody,
      start: { dateTime: '2026-10-20T18:00:00-04:00', timeZone: 'America/New_York' },
      end: { dateTime: '2026-10-21T06:00:00+01:00', timeZone: 'Europe/London' },
    };
    const body = await patchFor({ recurrence: ['RRULE:FREQ=WEEKLY'] }, flight);
    expect(body.start).toEqual({ dateTime: '2026-10-20T18:00:00-04:00', timeZone: 'America/New_York', date: null });
    expect(body.end).toEqual({ dateTime: '2026-10-21T06:00:00+01:00', timeZone: 'America/New_York', date: null });
  });

  it('canonicalizes the spelling of a time zone before sending it to Google', async () => {
    const body = await patchFor({ timeZone: 'europe/london' }, newYork);
    expect(body.start.timeZone).toBe('Europe/London');
  });

  it('rejects a time zone passed alone for an all-day event without patching', async () => {
    stub(GET_EVENT, { ...eventBody, start: { date: '2026-10-20' }, end: { date: '2026-10-21' } });
    const res = await run('update_event', { eventId: 'ev1', timeZone: 'Europe/London' });
    expect(res.isError).toBe(true);
    expect(errorOf(res).error).toMatch(/all-day/);
    expect(callsTo(PATCH_EVENT)).toHaveLength(0);
  });
});

describe('update_event guards', () => {
  it('refuses to update an occurrence that no longer exists', async () => {
    stub(GET_EVENT, { id: 'ev1', status: 'cancelled', summary: 'CANCELLED', start: { dateTime: '2026-10-20T10:00:00Z', timeZone: 'UTC' } });
    const res = await run('update_event', { eventId: 'ev1', end: '2026-10-20T11:00:00' });
    expect(res.isError).toBe(true);
    expect(errorOf(res).error).toMatch(/no longer exists.*list the series instances again/);
    expect(callsTo(PATCH_EVENT)).toHaveLength(0);
  });

  it('refuses a plain field patch on a cancelled occurrence without sending it', async () => {
    stub(GET_EVENT, { id: 'ev1', status: 'cancelled' });
    const res = await run('update_event', { eventId: 'ev1', summary: 'Renamed' });
    expect(res.isError).toBe(true);
    expect(errorOf(res).error).toMatch(/no longer exists/);
    expect(callsTo(PATCH_EVENT)).toHaveLength(0);
  });

  it('guards a plain field patch with the etag it read', async () => {
    stub(GET_EVENT, { ...eventBody, etag: '"s1"' });
    stub(PATCH_EVENT, eventBody);
    await run('update_event', { eventId: 'ev1', summary: 'Renamed' });
    const patch = only(PATCH_EVENT);
    expect(patch.headers['If-Match']).toBe('"s1"');
    expect(patch.body).toEqual({ summary: 'Renamed' });
  });

  it('refuses a visibility change on one occurrence and points to the series id', async () => {
    stub(GET_EVENT, { ...eventBody, recurringEventId: 'series1' });
    const res = await run('update_event', { eventId: 'ev1', visibility: 'private' });
    expect(res.isError).toBe(true);
    expect(errorOf(res)).toMatchObject({ recurringEventId: 'series1' });
    expect(errorOf(res).error).toMatch(/whole series.*"series1"/);
    expect(callsTo(PATCH_EVENT)).toHaveLength(0);
  });

  it('still patches other fields on one occurrence', async () => {
    stub(GET_EVENT, { ...eventBody, recurringEventId: 'series1' });
    stub(PATCH_EVENT, eventBody);
    await run('update_event', { eventId: 'ev1', summary: 'Just this one' });
    expect(only(PATCH_EVENT).body).toEqual({ summary: 'Just this one' });
  });

  it('gives format advice on a bad request only when the patch carried times', async () => {
    const badRequest = { error: { message: 'Bad Request', errors: [{ reason: 'badRequest' }] } };
    stub(GET_EVENT, eventBody);
    stub(PATCH_EVENT, badRequest, 400);
    const plain = errorOf(await run('update_event', { eventId: 'ev1', summary: 'Renamed' }));
    expect(plain.error).toBe('Invalid request to update calendar event: Bad Request');
    const timed = errorOf(await run('update_event', { eventId: 'ev1', start: '2026-10-21T10:00:00Z', end: '2026-10-21T11:00:00Z' }));
    expect(timed.error).toMatch(/Check parameter formats/);
  });

  it('refuses to make a stored focus-time event free', async () => {
    stub(GET_EVENT, { ...eventBody, eventType: 'focusTime' });
    const free = await run('update_event', { eventId: 'ev1', availability: 'free' });
    expect(free.isError).toBe(true);
    expect(errorOf(free)).toMatchObject({ eventType: 'focusTime' });
    expect(calls).toHaveLength(1);
  });

  it('refuses to make a stored working location private', async () => {
    stub(GET_EVENT, { ...eventBody, eventType: 'workingLocation' });
    const hidden = await run('update_event', { eventId: 'ev1', visibility: 'private' });
    expect(hidden.isError).toBe(true);
    expect(callsTo(PATCH_EVENT)).toHaveLength(0);
  });

  it('removes guests whose addresses a strict email pattern would reject', async () => {
    stub(GET_EVENT, { ...eventBody, attendees: [{ email: 'customer/department=shipping@example.com' }, { email: 'joão@x.com' }, { email: 'keep@x.com' }] });
    stub(PATCH_EVENT, eventBody);
    await run('update_event', { eventId: 'ev1', removeAttendees: ['customer/department=shipping@example.com', 'JOÃO@x.com'], addAttendees: ['a&b@xn--p1ai.xn--p1ai'] });
    expect(only(PATCH_EVENT).body.attendees).toEqual([{ email: 'keep@x.com' }, { email: 'a&b@xn--p1ai.xn--p1ai' }]);
  });

  it('loads the event before patching availability on an ordinary event', async () => {
    stub(GET_EVENT, { ...eventBody, etag: '"a1"' });
    stub(PATCH_EVENT, eventBody);
    await run('update_event', { eventId: 'ev1', availability: 'free' });
    const patch = only(PATCH_EVENT);
    expect(patch.headers['If-Match']).toBe('"a1"');
    expect(patch.body).toEqual({ transparency: 'transparent' });
  });

  it('gives only the rules for the event type and no generic format advice on a malformed event', async () => {
    stub(GET_EVENT, { ...eventBody, eventType: 'workingLocation' });
    stub(PATCH_EVENT, { error: { message: 'customLocation must have a non-empty label.', errors: [{ reason: 'malformedWorkingLocationEvent' }] } }, 400);
    const res = await run('update_event', { eventId: 'ev1', start: '2026-10-21T10:00:00Z', end: '2026-10-21T11:00:00Z' });
    const err = errorOf(res);
    expect(err.error).not.toMatch(/Check parameter formats/);
    expect(err.hint).toMatch(/^workingLocation events:/);
    expect(err.hint).not.toMatch(/timed, not all-day/);
  });
});
