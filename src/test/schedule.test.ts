import { describe, expect, it } from 'vitest';
import {
  assertOrdered,
  endOnlyTimes,
  inZone,
  lacksSharedZone,
  parseRange,
  parseReschedule,
  rangeTimes,
  relabel,
  seriesTimes,
  shiftedTimes,
  toPatchTime,
} from '../lib/schedule.js';

const zone = (tz: string) => async () => tz;
const noZone = async (): Promise<string> => { throw new Error('zone should not be needed'); };

describe('parseRange', () => {
  it('pairs two dates or two datetimes and rejects a mix', () => {
    expect(parseRange('2026-10-20', '2026-10-21').kind).toBe('date');
    expect(parseRange('2026-10-20T10:00:00', '2026-10-20T11:00:00Z').kind).toBe('datetime');
    expect(() => parseRange('2026-10-20', '2026-10-20T11:00:00')).toThrow(/same kind/);
    expect(() => parseRange('tomorrow', '2026-10-21')).toThrow(/Invalid `start`/);
  });
});

describe('parseReschedule', () => {
  it('tells a full range from a single bound', () => {
    expect(parseReschedule(undefined, undefined)).toBeUndefined();
    expect(parseReschedule('2026-10-20', '2026-10-21')?.kind).toBe('range');
    expect(parseReschedule('2026-10-20', undefined)?.kind).toBe('start');
    expect(parseReschedule(undefined, '2026-10-21')?.kind).toBe('end');
  });
});

describe('rangeTimes', () => {
  it('names a zone only when a bound is naive', async () => {
    expect(await rangeTimes(parseRange('2026-10-20T10:00:00Z', '2026-10-20T11:00:00Z'), noZone)).toEqual({
      start: { dateTime: '2026-10-20T10:00:00Z' },
      end: { dateTime: '2026-10-20T11:00:00Z' },
    });
    expect(await rangeTimes(parseRange('2026-10-20T10:00:00', '2026-10-20T11:00:00Z'), zone('UTC'))).toEqual({
      start: { dateTime: '2026-10-20T10:00:00', timeZone: 'UTC' },
      end: { dateTime: '2026-10-20T11:00:00Z', timeZone: 'UTC' },
    });
  });
});

describe('assertOrdered', () => {
  it('rejects a range that ends before it starts', () => {
    expect(() => assertOrdered({ start: { date: '2026-10-21' }, end: { date: '2026-10-21' } })).toThrow(/after `start`/);
    expect(() => assertOrdered({
      start: { dateTime: '2026-10-20T11:00:00-03:00' },
      end: { dateTime: '2026-10-20T10:00:00', timeZone: 'America/Recife' },
    })).toThrow(/after `start`/);
  });

  it('names the skipped local time when a spring-forward gap collapses the range', () => {
    const tz = 'America/New_York';
    expect(() => assertOrdered({
      start: { dateTime: '2027-03-14T02:30:00', timeZone: tz },
      end: { dateTime: '2027-03-14T03:30:00', timeZone: tz },
    })).toThrow(/2027-03-14T02:30:00 does not exist in America\/New_York/);
  });

  it('accepts a gap time when the range still ends after it starts', () => {
    const tz = 'America/New_York';
    expect(() => assertOrdered({
      start: { dateTime: '2027-03-14T02:30:00', timeZone: tz },
      end: { dateTime: '2027-03-14T04:00:00', timeZone: tz },
    })).not.toThrow();
  });
});

describe('single-bound reschedules', () => {
  const timed = { id: 'e', start: { dateTime: '2026-10-20T10:00:00-03:00' }, end: { dateTime: '2026-10-20T10:30:00-03:00' } };
  const allDay = { id: 'e', start: { date: '2026-10-20' }, end: { date: '2026-10-22' } };

  it('keeps the duration when only the start moves', async () => {
    const start = parseRange('2026-10-22T15:00:00', '2026-10-22T16:00:00').start;
    expect(await shiftedTimes(timed, start, zone('America/Recife'), zone('America/Recife'))).toEqual({
      start: { dateTime: '2026-10-22T15:00:00', timeZone: 'America/Recife' },
      end: { dateTime: '2026-10-22T15:30:00-03:00', timeZone: 'America/Recife' },
    });
  });

  it('reads a naive start in the input zone and writes the derived end in the end zone', async () => {
    const start = parseRange('2026-10-22T15:00:00', '2026-10-22T16:00:00').start;
    expect(await shiftedTimes(timed, start, zone('America/Recife'), zone('Europe/London'))).toEqual({
      start: { dateTime: '2026-10-22T15:00:00', timeZone: 'America/Recife' },
      end: { dateTime: '2026-10-22T19:30:00+01:00', timeZone: 'Europe/London' },
    });
  });

  it('pins the offset of a derived end that lands in the repeated fall-back hour', async () => {
    const hour = { id: 'e', start: { dateTime: '2026-10-30T09:00:00-04:00' }, end: { dateTime: '2026-10-30T10:00:00-04:00' } };
    const start = parseRange('2026-11-01T01:30:00', '2026-11-01T02:00:00').start;
    expect((await shiftedTimes(hour, start, zone('America/New_York'), zone('America/New_York'))).end).toEqual({
      dateTime: '2026-11-01T01:30:00-05:00',
      timeZone: 'America/New_York',
    });
  });

  it('refuses a lone bound of the other kind', async () => {
    const date = parseRange('2026-11-01', '2026-11-02').start;
    await expect(shiftedTimes(timed, date, noZone, noZone)).rejects.toThrow(/timed event/);
    const dt = parseRange('2026-11-01T10:00:00Z', '2026-11-01T11:00:00Z').end;
    await expect(endOnlyTimes(allDay, dt, noZone)).rejects.toThrow(/all-day event/);
  });

  it('keeps the stored start for an end-only change and only looks up a zone for a naive end', async () => {
    const offsetEnd = parseRange('2026-10-20T10:00:00Z', '2026-10-20T11:00:00-03:00').end;
    expect(await endOnlyTimes(timed, offsetEnd, noZone)).toEqual({
      start: { dateTime: '2026-10-20T10:00:00-03:00' },
      end: { dateTime: '2026-10-20T11:00:00-03:00' },
    });
    const naiveEnd = parseRange('2026-10-20T10:00:00', '2026-10-20T11:00:00').end;
    expect((await endOnlyTimes(timed, naiveEnd, zone('America/Recife'))).end).toEqual({ dateTime: '2026-10-20T11:00:00', timeZone: 'America/Recife' });
  });
});

describe('relabel', () => {
  it('keeps the instant while naming the requested zone', () => {
    expect(relabel({ dateTime: '2026-10-22T15:00:00', timeZone: 'America/Recife' }, 'America/New_York'))
      .toEqual({ dateTime: '2026-10-22T15:00:00-03:00', timeZone: 'America/New_York' });
    expect(relabel({ dateTime: '2026-10-22T15:00:00Z' }, 'Europe/Lisbon')).toEqual({ dateTime: '2026-10-22T15:00:00Z', timeZone: 'Europe/Lisbon' });
  });

  it('leaves dates, matching zones and missing labels alone', () => {
    const naive = { dateTime: '2026-10-22T15:00:00', timeZone: 'UTC' };
    expect(relabel(naive, 'UTC')).toBe(naive);
    expect(relabel(naive, undefined)).toBe(naive);
    expect(relabel({ date: '2026-10-22' }, 'UTC')).toEqual({ date: '2026-10-22' });
  });
});

describe('named zones and patch shapes', () => {
  it('spots timed ranges without a named zone and fills one in', () => {
    const offsetOnly = { start: { dateTime: '2026-10-20T10:00:00Z' }, end: { dateTime: '2026-10-20T11:00:00Z' } };
    expect(lacksSharedZone(offsetOnly)).toBe(true);
    expect(lacksSharedZone({ start: { date: '2026-10-20' }, end: { date: '2026-10-21' } })).toBe(false);
    expect(lacksSharedZone(inZone(offsetOnly, 'UTC'))).toBe(false);
  });

  it('moves a series with two different endpoint zones into one zone keeping both instants', async () => {
    const flight = {
      start: { dateTime: '2026-10-20T18:00:00', timeZone: 'America/New_York' },
      end: { dateTime: '2026-10-21T06:00:00', timeZone: 'Europe/London' },
    };
    expect(lacksSharedZone(flight)).toBe(true);
    expect(await seriesTimes(flight, false, noZone)).toBe(flight);
    expect(await seriesTimes(flight, true, zone('America/New_York'))).toEqual({
      start: { dateTime: '2026-10-20T18:00:00', timeZone: 'America/New_York' },
      end: { dateTime: '2026-10-21T06:00:00+01:00', timeZone: 'America/New_York' },
    });
  });

  it('clears the other kind so a PATCH can switch between timed and all-day', () => {
    expect(toPatchTime({ date: '2026-11-05' })).toEqual({ date: '2026-11-05', dateTime: null, timeZone: null });
    expect(toPatchTime({ dateTime: '2026-11-05T10:00:00', timeZone: 'UTC' })).toEqual({ dateTime: '2026-11-05T10:00:00', timeZone: 'UTC', date: null });
  });
});
