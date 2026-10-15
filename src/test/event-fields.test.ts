import { describe, expect, it } from 'vitest';
import { buildEventOptions, mergeAttendees, type AttendeeLike } from '../lib/event-fields.js';

describe('buildEventOptions', () => {
  it('returns an empty body when no option is set', () => {
    expect(buildEventOptions({})).toEqual({});
  });

  it('passes recurrence, colorId and visibility through unchanged', () => {
    expect(buildEventOptions({
      recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
      colorId: '5',
      visibility: 'private',
    })).toEqual({
      recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
      colorId: '5',
      visibility: 'private',
    });
  });

  it('maps availability onto transparency', () => {
    expect(buildEventOptions({ availability: 'free' })).toEqual({ transparency: 'transparent' });
    expect(buildEventOptions({ availability: 'busy' })).toEqual({ transparency: 'opaque' });
  });

  it('turns reminder overrides into a non-default reminder set', () => {
    expect(buildEventOptions({ reminders: { overrides: [{ method: 'popup', minutes: 15 }] } })).toEqual({
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 15 }] },
    });
  });

  it('removes every reminder when useDefault is false and no override is given', () => {
    expect(buildEventOptions({ reminders: { useDefault: false } })).toEqual({
      reminders: { useDefault: false, overrides: [] },
    });
  });

  it('restores the calendar default reminders when useDefault is true', () => {
    expect(buildEventOptions({ reminders: { useDefault: true } })).toEqual({
      reminders: { useDefault: true },
    });
  });

  it('requests a Google Meet conference with a fresh request id', () => {
    expect(buildEventOptions({ addGoogleMeet: true }, () => 'req-1')).toEqual({
      conferenceData: { createRequest: { requestId: 'req-1', conferenceSolutionKey: { type: 'hangoutsMeet' } } },
    });
    expect(buildEventOptions({ addGoogleMeet: false })).toEqual({});
  });
});

describe('mergeAttendees', () => {
  const existing: AttendeeLike[] = [
    { email: 'a@example.com', responseStatus: 'accepted' },
    { email: 'B@example.com', responseStatus: 'declined', optional: true },
  ];

  it('keeps existing entries untouched so their responses survive', () => {
    const out = mergeAttendees(existing, [{ email: 'c@example.com' }], []);
    expect(out).toEqual([...existing, { email: 'c@example.com' }]);
  });

  it('skips additions that already attend, matching email case-insensitively', () => {
    const out = mergeAttendees(existing, [{ email: 'b@EXAMPLE.com', displayName: 'Bee' }], []);
    expect(out).toEqual(existing);
  });

  it('removes by email case-insensitively', () => {
    expect(mergeAttendees(existing, [], ['A@example.com'])).toEqual([existing[1]]);
  });

  it('applies removals before additions so a re-added person starts fresh', () => {
    const out = mergeAttendees(existing, [{ email: 'a@example.com' }], ['a@example.com']);
    expect(out).toEqual([existing[1], { email: 'a@example.com' }]);
  });

  it('tolerates a missing attendee list', () => {
    expect(mergeAttendees(undefined, [{ email: 'x@example.com' }], [])).toEqual([{ email: 'x@example.com' }]);
  });
});
