import { describe, expect, it } from 'vitest';
import { buildEventOptions, mergeAttachments, mergeAttendees, normalizeAttachments, type AttendeeLike } from '../lib/event-fields.js';

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
      outOfOfficeProperties: { autoDeclineMode: 'declineAllConflictingInvitations', declineMessage: 'Away' },
    });
    expect(buildEventOptions({ eventType: 'outOfOffice' })).toEqual({
      eventType: 'outOfOffice',
      outOfOfficeProperties: { autoDeclineMode: 'declineAllConflictingInvitations' },
    });
  });

  it('builds a focus-time event with chat status and decline settings', () => {
    expect(buildEventOptions({
      eventType: 'focusTime',
      focusTime: { autoDeclineMode: 'declineNone', chatStatus: 'doNotDisturb' },
    })).toEqual({
      eventType: 'focusTime',
      focusTimeProperties: { autoDeclineMode: 'declineNone', chatStatus: 'doNotDisturb' },
    });
    expect(buildEventOptions({ eventType: 'focusTime' })).toEqual({
      eventType: 'focusTime',
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

  it('refuses to make a working location private or busy', () => {
    expect(() => buildEventOptions({ eventType: 'workingLocation', visibility: 'private' })).toThrow(/public/);
    expect(() => buildEventOptions({ eventType: 'workingLocation', availability: 'busy' })).toThrow(/free/);
  });

  it('requires a label for a custom working location and defaults to home office', () => {
    expect(() => buildEventOptions({ eventType: 'workingLocation', workingLocation: { type: 'customLocation' } })).toThrow(/label/);
    expect(buildEventOptions({ eventType: 'workingLocation' })).toMatchObject({
      workingLocationProperties: { type: 'homeOffice', homeOffice: {} },
    });
  });

  it('infers the event type from the settings given, and rejects settings for another type', () => {
    expect(buildEventOptions({ focusTime: { chatStatus: 'available' } })).toEqual({
      eventType: 'focusTime',
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
