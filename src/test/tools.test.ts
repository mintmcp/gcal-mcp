import { describe, expect, it } from 'vitest';
import { describeAttendeeRoster, identifyCallerAttendee, truncateBody } from '../tools.js';

const caller = 'me@example.com';

describe('describeAttendeeRoster', () => {
  it('caps the disclosed roster to a sample plus a remainder count', () => {
    const attendees = ['a', 'b', 'c', 'd', 'e'].map(n => ({ email: `${n}@example.com` }));
    expect(describeAttendeeRoster(attendees)).toBe(
      '5 attendee(s), e.g. a@example.com, b@example.com, c@example.com and 2 more',
    );
  });

  it('omits the remainder when the roster fits in the sample', () => {
    expect(describeAttendeeRoster([{ email: 'only@example.com' }])).toBe('1 attendee(s), e.g. only@example.com');
  });

  it('reports a count with no sample for an empty roster', () => {
    expect(describeAttendeeRoster([])).toBe('0 attendee(s)');
  });

  it('ignores rows without a string email', () => {
    const attendees = [{ email: undefined as unknown as string }, { email: 'real@example.com' }];
    expect(describeAttendeeRoster(attendees)).toBe('2 attendee(s), e.g. real@example.com');
  });
});

describe('truncateBody', () => {
  it('truncates an over-long body and marks it', () => {
    const out = truncateBody('x'.repeat(500));
    expect(out).toHaveLength(303);
    expect(out.endsWith('...')).toBe(true);
  });

  it('leaves a short body intact and collapses whitespace', () => {
    expect(truncateBody('  hello   world \n')).toBe('hello world');
  });

  it('returns an empty string for a missing body', () => {
    expect(truncateBody(undefined)).toBe('');
  });
});

describe('identifyCallerAttendee', () => {
  it('matches the caller by email even when self:true belongs to someone else', () => {
    const owner = { email: 'owner@example.com', self: true, responseStatus: 'accepted' };
    const mine = { email: caller, responseStatus: 'needsAction' };
    const match = identifyCallerAttendee([owner, mine], caller, 'owner@example.com');
    expect(match).toEqual({ kind: 'found', attendee: mine });
  });

  it('matches the caller email case-insensitively', () => {
    const mine = { email: 'Me@Example.COM', responseStatus: 'needsAction' };
    const match = identifyCallerAttendee([mine], 'ME@example.com', 'primary');
    expect(match).toEqual({ kind: 'found', attendee: mine });
  });

  it('falls back to self on the primary calendar when the caller was invited under an alias', () => {
    const alias = { email: 'alias@example.com', self: true, responseStatus: 'needsAction' };
    expect(identifyCallerAttendee([alias], caller, 'primary')).toEqual({ kind: 'found', attendee: alias });
  });

  it('treats the caller own address as their own calendar, not a shared one', () => {
    const alias = { email: 'alias@example.com', self: true };
    expect(identifyCallerAttendee([alias], caller, 'ME@example.com')).toEqual({ kind: 'found', attendee: alias });
  });

  it('never falls back to self on a calendar that is not the caller own', () => {
    const owner = { email: 'owner@example.com', self: true };
    expect(identifyCallerAttendee([owner], caller, 'owner@example.com')).toEqual({ kind: 'notFound' });
    expect(identifyCallerAttendee([owner], caller, 'team@group.calendar.google.com'))
      .toEqual({ kind: 'notFound' });
  });

  it('falls back to the self entry when the caller email is unknown, on the primary calendar', () => {
    const mine = { email: 'anything@example.com', self: true };
    expect(identifyCallerAttendee([mine], undefined, 'primary')).toEqual({ kind: 'found', attendee: mine });
  });

  it('prefers the email match over a self row when both are present', () => {
    const flagged = { email: 'alias@example.com', self: true };
    const mine = { email: caller };
    expect(identifyCallerAttendee([flagged, mine], caller, 'primary')).toEqual({ kind: 'found', attendee: mine });
  });

  it('refuses to guess on a non-primary calendar when the caller email is unknown', () => {
    const owner = { email: 'owner@example.com', self: true };
    expect(identifyCallerAttendee([owner], undefined, 'owner@example.com'))
      .toEqual({ kind: 'unverifiableCalendar' });
    expect(identifyCallerAttendee([owner], '', 'team@group.calendar.google.com'))
      .toEqual({ kind: 'unverifiableCalendar' });
  });

  it('reports notFound on the primary calendar when no entry is flagged self', () => {
    const other = { email: 'other@example.com' };
    expect(identifyCallerAttendee([other], undefined, 'primary')).toEqual({ kind: 'notFound' });
  });

  it('reports notFound for an empty attendee list', () => {
    expect(identifyCallerAttendee([], caller, 'primary')).toEqual({ kind: 'notFound' });
    expect(identifyCallerAttendee([], undefined, 'primary')).toEqual({ kind: 'notFound' });
    expect(identifyCallerAttendee([], undefined, 'shared@example.com')).toEqual({ kind: 'unverifiableCalendar' });
  });

  it('ignores attendee rows with a non-string email', () => {
    const broken = { email: undefined as unknown as string, self: true };
    const mine = { email: caller };
    expect(identifyCallerAttendee([broken, mine], caller, 'primary')).toEqual({ kind: 'found', attendee: mine });
  });
});
