import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { mergeAttachments, normalizeAttachments } from '../lib/attachments.js';
import { attendeeInputSchema, describeAttendeeRoster, emailSchema, mergeAttendees, normalizeAttendees } from '../lib/attendees.js';
import { buildEventOptions, validateEventTypeTimes, withEventTypeHint } from '../lib/event-options.js';
import type { EventAttendee } from '../lib/event-model.js';
import { ToolFailure } from '../lib/failure.js';

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
  const existing: EventAttendee[] = [
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

  it('rejects removing someone who is not a guest instead of silently doing nothing', () => {
    expect(() => mergeAttendees(existing, [], ['nobody@example.com'])).toThrow(/nobody@example.com/);
  });

  it('applies removals before additions so a re-added person starts fresh', () => {
    const out = mergeAttendees(existing, [{ email: 'a@example.com' }], ['a@example.com']);
    expect(out).toEqual([existing[1], { email: 'a@example.com' }]);
  });

  it('tolerates a missing attendee list', () => {
    expect(mergeAttendees(undefined, [{ email: 'x@example.com' }], [])).toEqual([{ email: 'x@example.com' }]);
  });

  it('matches a punycode domain against the Unicode spelling Google stores, and the reverse', () => {
    const unicode = { email: 'user@рф.рф', responseStatus: 'accepted' };
    const punycode = { email: 'user@xn--p1ai.xn--p1ai', responseStatus: 'accepted' };
    expect(mergeAttendees([unicode], [], ['user@xn--p1ai.xn--p1ai'])).toEqual([]);
    expect(mergeAttendees([punycode], [], ['USER@РФ.РФ'])).toEqual([]);
    expect(mergeAttendees([unicode], [{ email: 'user@XN--P1AI.xn--p1ai' }], [])).toEqual([unicode]);
    expect(mergeAttendees([punycode], [{ email: 'user@рф.рф' }], [])).toEqual([punycode]);
  });
});

describe('buildEventOptions guest permissions and event types', () => {
  it('maps guest permissions onto the three Google flags', () => {
    expect(buildEventOptions({
      guestPermissions: { canModify: true, canInviteOthers: false, canSeeOtherGuests: false },
    })).toEqual({ guestsCanModify: true, guestsCanInviteOthers: false, guestsCanSeeOtherGuests: false });
    expect(buildEventOptions({ guestPermissions: { canInviteOthers: true } })).toEqual({ guestsCanInviteOthers: true });
  });

  it('builds an out-of-office event with its decline settings', () => {
    expect(buildEventOptions({
      eventType: 'outOfOffice',
      outOfOffice: { autoDeclineMode: 'declineAllConflictingInvitations', declineMessage: 'Away' },
    })).toEqual({
      eventType: 'outOfOffice',
      transparency: 'opaque',
      outOfOfficeProperties: { autoDeclineMode: 'declineAllConflictingInvitations', declineMessage: 'Away' },
    });
    expect(buildEventOptions({ eventType: 'outOfOffice' })).toEqual({
      eventType: 'outOfOffice',
      transparency: 'opaque',
      outOfOfficeProperties: { autoDeclineMode: 'declineAllConflictingInvitations' },
    });
  });

  it('builds a focus-time event with chat status and decline settings', () => {
    expect(buildEventOptions({
      eventType: 'focusTime',
      focusTime: { autoDeclineMode: 'declineNone', chatStatus: 'doNotDisturb' },
    })).toEqual({
      eventType: 'focusTime',
      transparency: 'opaque',
      focusTimeProperties: { autoDeclineMode: 'declineNone', chatStatus: 'doNotDisturb' },
    });
    expect(buildEventOptions({ eventType: 'focusTime' })).toEqual({
      eventType: 'focusTime',
      transparency: 'opaque',
      focusTimeProperties: { autoDeclineMode: 'declineNone', chatStatus: 'doNotDisturb' },
    });
  });

  it('builds the three working-location shapes, public and free as Google requires', () => {
    expect(buildEventOptions({ eventType: 'workingLocation', workingLocation: { type: 'homeOffice' } })).toEqual({
      eventType: 'workingLocation',
      visibility: 'public',
      transparency: 'transparent',
      workingLocationProperties: { type: 'homeOffice', homeOffice: {} },
    });
    expect(buildEventOptions({ eventType: 'workingLocation', workingLocation: { type: 'customLocation', label: 'Cafe' } })).toMatchObject({
      workingLocationProperties: { type: 'customLocation', customLocation: { label: 'Cafe' } },
    });
    expect(buildEventOptions({
      eventType: 'workingLocation',
      workingLocation: { type: 'officeLocation', label: 'HQ', buildingId: 'b1', floorId: '3', deskId: 'd7' },
    })).toMatchObject({
      workingLocationProperties: { type: 'officeLocation', officeLocation: { label: 'HQ', buildingId: 'b1', floorId: '3', deskId: 'd7' } },
    });
  });

  it('refuses to make out-of-office or focus time free, since Google needs them to block time', () => {
    expect(() => buildEventOptions({ eventType: 'focusTime', availability: 'free' })).toThrow(/busy/);
    expect(() => buildEventOptions({ outOfOffice: {}, availability: 'free' })).toThrow(/busy/);
    expect(buildEventOptions({ eventType: 'focusTime', availability: 'busy' })).toMatchObject({ transparency: 'opaque' });
  });

  it('refuses to make a working location private or busy', () => {
    expect(() => buildEventOptions({ eventType: 'workingLocation', visibility: 'private' })).toThrow(/public/);
    expect(() => buildEventOptions({ eventType: 'workingLocation', availability: 'busy' })).toThrow(/free/);
  });

  it('requires a label for a custom working location, as Google does, and defaults to home office', () => {
    expect(() => buildEventOptions({ eventType: 'workingLocation', workingLocation: { type: 'customLocation' } })).toThrow(/label/);
    expect(() => buildEventOptions({ eventType: 'workingLocation', workingLocation: { type: 'customLocation', label: '  ' } })).toThrow(/label/);
    expect(buildEventOptions({ eventType: 'workingLocation' })).toMatchObject({
      workingLocationProperties: { type: 'homeOffice', homeOffice: {} },
    });
  });

  it('infers the event type from the settings given, and rejects settings for another type', () => {
    expect(buildEventOptions({ focusTime: { chatStatus: 'available' } })).toEqual({
      eventType: 'focusTime',
      transparency: 'opaque',
      focusTimeProperties: { autoDeclineMode: 'declineNone', chatStatus: 'available' },
    });
    expect(() => buildEventOptions({ eventType: 'default', focusTime: { chatStatus: 'available' } })).toThrow(/focusTime/);
    expect(() => buildEventOptions({ outOfOffice: {}, workingLocation: {} })).toThrow(/one event type/);
  });
});

describe('normalizeAttachments', () => {
  it('accepts Drive URLs as given and turns bare file ids into open links', () => {
    expect(normalizeAttachments([
      'https://docs.google.com/document/d/1abcDEF_-xyz/edit',
      '1abcDEF_-xyz',
      { fileUrl: 'https://drive.google.com/file/d/1abc/view', title: 'Deck' },
      { fileId: '1xyz', title: 'Notes' },
    ])).toEqual([
      { fileUrl: 'https://docs.google.com/document/d/1abcDEF_-xyz/edit' },
      { fileUrl: 'https://drive.google.com/open?id=1abcDEF_-xyz' },
      { fileUrl: 'https://drive.google.com/file/d/1abc/view', title: 'Deck' },
      { fileUrl: 'https://drive.google.com/open?id=1xyz', title: 'Notes' },
    ]);
  });

  it('rejects anything that is neither a URL nor a Drive file id', () => {
    expect(() => normalizeAttachments(['not a file'])).toThrow(/Drive/);
  });

  it('refuses more than 25 attachments up front', () => {
    expect(() => normalizeAttachments(Array.from({ length: 26 }, (_, i) => `file${i}`))).toThrow(/25/);
  });
});

describe('mergeAttachments', () => {
  const existing = [
    { fileUrl: 'https://drive.google.com/open?id=1keep', fileId: '1keep', title: 'Keep' },
    { fileUrl: 'https://docs.google.com/document/d/1gone/edit', fileId: '1gone', title: 'Gone' },
  ];

  it('removes by file id or url and appends new ones without duplicating', () => {
    expect(mergeAttachments(existing, [
      { fileUrl: 'https://drive.google.com/open?id=1keep' },
      { fileUrl: 'https://drive.google.com/open?id=1new' },
    ], ['1gone'])).toEqual([existing[0], { fileUrl: 'https://drive.google.com/open?id=1new' }]);
    expect(mergeAttachments(existing, [], ['https://docs.google.com/document/d/1gone/edit'])).toEqual([existing[0]]);
  });

  it('rejects removing an attachment the event does not have', () => {
    expect(() => mergeAttachments(existing, [], ['1missing'])).toThrow(/1missing/);
    expect(() => mergeAttachments(existing, [], ['not a file'])).toThrow(/Drive/);
  });

  it('refuses to grow past the 25 attachments Google allows', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ fileUrl: `https://drive.google.com/open?id=file${i}` }));
    expect(() => mergeAttachments(many, [{ fileUrl: 'https://drive.google.com/open?id=one-more' }], [])).toThrow(/25/);
    expect(mergeAttachments(many, [{ fileUrl: 'https://drive.google.com/open?id=one-more' }], ['file0'])).toHaveLength(25);
  });

  it('tolerates an event with no attachments', () => {
    expect(mergeAttachments(undefined, [{ fileUrl: 'https://drive.google.com/open?id=1a' }], [])).toEqual([
      { fileUrl: 'https://drive.google.com/open?id=1a' },
    ]);
  });
});

describe('normalizeAttendees', () => {
  it('turns bare emails into attendee entries', () => {
    expect(normalizeAttendees(['a@x.com', 'b@x.com'])).toEqual([{ email: 'a@x.com' }, { email: 'b@x.com' }]);
    expect(normalizeAttendees([])).toEqual([]);
  });

  it('keeps displayName and the flags that are set, dropping empty or false ones', () => {
    expect(normalizeAttendees([
      { email: 'a@x.com', displayName: 'Alice', optional: true },
      { email: 'b@x.com', displayName: '', optional: false },
      { email: 'room@x.com', resource: true },
      { email: 'c@x.com', additionalGuests: 2, responseStatus: 'accepted' },
      { email: 'd@x.com', additionalGuests: 0, resource: false },
    ])).toEqual([
      { email: 'a@x.com', displayName: 'Alice', optional: true },
      { email: 'b@x.com' },
      { email: 'room@x.com', resource: true },
      { email: 'c@x.com', additionalGuests: 2, responseStatus: 'accepted' },
      { email: 'd@x.com' },
    ]);
  });
});

describe('validateEventTypeTimes', () => {
  const allDay = (start: string, end: string) => ({ start: { date: start }, end: { date: end } });

  it('refuses all-day out-of-office and focus time', () => {
    expect(() => validateEventTypeTimes('outOfOffice', allDay('2026-10-20', '2026-10-21'))).toThrow(/timed/);
    expect(() => validateEventTypeTimes('focusTime', allDay('2026-10-20', '2026-10-21'))).toThrow(/timed/);
  });

  it('allows an all-day working location only when it covers one day', () => {
    expect(() => validateEventTypeTimes('workingLocation', allDay('2026-10-20', '2026-10-22'))).toThrow(/one day/);
    expect(() => validateEventTypeTimes('workingLocation', allDay('2026-10-20', '2026-10-21'))).not.toThrow();
  });

  it('leaves timed events and ordinary types alone', () => {
    const timed = { start: { dateTime: '2026-10-20T10:00:00Z' }, end: { dateTime: '2026-10-20T11:00:00Z' } };
    expect(() => validateEventTypeTimes('focusTime', timed)).not.toThrow();
    expect(() => validateEventTypeTimes('default', allDay('2026-10-20', '2026-10-25'))).not.toThrow();
    expect(() => validateEventTypeTimes(undefined, allDay('2026-10-20', '2026-10-25'))).not.toThrow();
  });
});

describe('withEventTypeHint', () => {
  it('names only the rules of the event type involved', () => {
    const bad = new ToolFailure({ error: 'Invalid request', status: 400 });
    const focus = (withEventTypeHint(bad, 'focusTime') as ToolFailure).payload.hint;
    expect(focus).toBe('focusTime events: only accepted on the user\'s primary calendar (calendarId "primary"); must be timed, not all-day; always busy.');
    const office = (withEventTypeHint(bad, 'workingLocation') as ToolFailure).payload.hint;
    expect(office).toMatch(/exactly one day; always free and public/);
    expect(office).not.toMatch(/timed/);
  });

  it('adds the event type rules to a 400 for a special event type only', () => {
    const bad = new ToolFailure({ error: 'Invalid request', status: 400 });
    const hinted = withEventTypeHint(bad, 'outOfOffice') as ToolFailure;
    expect(hinted.payload).toMatchObject({ error: 'Invalid request', eventType: 'outOfOffice' });
    expect(hinted.payload.hint).toMatch(/primary calendar/);
    expect(withEventTypeHint(bad, 'default')).toBe(bad);
    const notFound = new ToolFailure({ error: 'gone', status: 404 });
    expect(withEventTypeHint(notFound, 'focusTime')).toBe(notFound);
  });
});

describe('describeAttendeeRoster', () => {
  it('summarises the roster without listing everyone', () => {
    expect(describeAttendeeRoster([{ email: 'a@x.com' }, { email: 'b@x.com' }], 1)).toBe('2 attendee(s), e.g. a@x.com and 1 more');
  });
});

describe('emailSchema', () => {
  const unusual = ['a&b@x.com', 'user@xn--p1ai.xn--p1ai', 'joão@x.com', 'customer/department=shipping@example.com', "o'brien@example.com"];

  it('accepts addresses Google accepts, trimming whitespace around them', () => {
    for (const email of unusual) expect(emailSchema.parse(` ${email} `)).toBe(email);
  });

  it('rejects strings that are not shaped like one address', () => {
    for (const bad of ['', '   ', 'no-at-sign', '@example.com', 'user@', 'a@b@example.com', 'two words@example.com']) {
      expect(emailSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('publishes no pattern or format that a client would enforce before Google sees the address', () => {
    const json = JSON.stringify(z.toJSONSchema(z.object({ email: emailSchema, attendee: attendeeInputSchema })));
    expect(json).not.toMatch(/"pattern"|"format"/);
  });

  it('removes attendees with unusual addresses, matching case-insensitively', () => {
    const existing = unusual.map(email => ({ email }));
    expect(mergeAttendees(existing, [], unusual.map(e => e.toUpperCase()))).toEqual([]);
  });
});
