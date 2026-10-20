import { describe, expect, it } from 'vitest';
import { decodePageToken, encodePageToken, queryFingerprint } from '../lib/page-token.js';

describe('page tokens', () => {
  const query = queryFingerprint({ calendarId: 'primary', q: 'sync' });

  it('round-trips the Google token and the resolved bounds', () => {
    const cursor = { googleToken: 'g', timeMin: '2026-10-20T00:00:00Z', timeMax: '2026-10-21T00:00:00Z', query };
    expect(decodePageToken(encodePageToken(cursor), query)).toEqual(cursor);
  });

  it('rejects a token reused with a different listing', () => {
    const token = encodePageToken({ googleToken: 'g', timeMin: '2026-10-20T00:00:00Z', query });
    expect(() => decodePageToken(token, queryFingerprint({ calendarId: 'primary', q: 'other' }))).toThrow(/different listing/);
  });

  it('rejects tokens it did not issue', () => {
    expect(() => decodePageToken('raw-google-token', query)).toThrow(/not one this tool issued/);
    expect(() => decodePageToken('gcalpage1.!!!', query)).toThrow(/not one this tool issued/);
  });

  it('fingerprints queries by content, ignoring absent fields', () => {
    expect(queryFingerprint({ q: 'a', eventTypes: undefined })).toBe(queryFingerprint({ q: 'a' }));
    expect(queryFingerprint({ q: 'a' })).not.toBe(queryFingerprint({ q: 'b' }));
  });
});
