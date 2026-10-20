import { createHash } from "node:crypto";
import { fail } from "./failure.js";

const PREFIX = "gcalpage1.";

export interface PageCursor {
  googleToken: string;
  timeMin: string;
  timeMax?: string;
  query: string;
}

export function queryFingerprint(query: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(query)).digest("base64url").slice(0, 16);
}

export function encodePageToken(cursor: PageCursor): string {
  return PREFIX + Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function parseCursor(token: string): PageCursor | undefined {
  if (!token.startsWith(PREFIX)) return undefined;
  try {
    const c = JSON.parse(Buffer.from(token.slice(PREFIX.length), "base64url").toString("utf8"));
    const valid = typeof c?.googleToken === "string" && typeof c.timeMin === "string" && typeof c.query === "string"
      && (c.timeMax === undefined || typeof c.timeMax === "string");
    return valid ? c : undefined;
  } catch {
    return undefined;
  }
}

export function decodePageToken(token: string, query: string): PageCursor {
  const cursor = parseCursor(token) ?? fail("This `pageToken` is not one this tool issued. Pass the `nextPageToken` from the previous response, or drop `pageToken` to start a new listing.");
  if (cursor.query !== query) {
    fail("This `pageToken` belongs to a different listing. Pass the same calendarId, q, filters and time bounds as the call that returned it, or drop `pageToken` to start a new listing.");
  }
  return cursor;
}
