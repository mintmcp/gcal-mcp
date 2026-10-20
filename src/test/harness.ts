import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestContext } from '../auth.js';
import { TOOLS } from '../tools/index.js';

type Call = { route: string; url: URL; method: string; headers: Record<string, string>; body?: any };

export const CALENDAR = 'GET /calendar/v3/calendars/primary';
export const LIST_EVENTS = 'GET /calendar/v3/calendars/primary/events';
export const INSERT_EVENT = 'POST /calendar/v3/calendars/primary/events';
export const GET_EVENT = 'GET /calendar/v3/calendars/primary/events/ev1';
export const PATCH_EVENT = 'PATCH /calendar/v3/calendars/primary/events/ev1';
export const FREE_BUSY = 'POST /calendar/v3/freeBusy';

export const calls: Call[] = [];
const routes = new Map<string, Array<{ status: number; body: unknown }>>();

export function stub(route: string, body: unknown, status = 200) {
  routes.set(route, [...(routes.get(route) ?? []), { status, body }]);
}

export function callsTo(route: string) {
  return calls.filter(c => c.route === route);
}

export function only(route: string) {
  const matching = callsTo(route);
  expect(matching).toHaveLength(1);
  return matching[0];
}

function stubFetch() {
  return vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const route = `${method} ${url.pathname}`;
    calls.push({
      route,
      url,
      method,
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const queue = routes.get(route) ?? [];
    const next = (queue.length > 1 ? queue.shift() : queue[0]) ?? { status: 500, body: { error: { message: `unstubbed ${route}` } } };
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

export function tool(name: string) {
  const found = TOOLS.find(t => t.name === name);
  if (!found) throw new Error(`unknown tool ${name}`);
  return found;
}

interface TestResult {
  isError?: boolean;
  content: Array<{ text: string }>;
  structuredContent?: any;
}

export async function run(name: string, args: Record<string, unknown>): Promise<TestResult> {
  const res = await requestContext.run({ accessToken: 'token' }, () => tool(name).handler(args));
  return { ...res, content: res.content.map(c => ({ text: c.type === 'text' ? c.text : '' })) };
}

export const calendarBody = { id: 'joao@example.com', timeZone: 'America/Recife' };
export const eventBody = {
  id: 'ev1',
  summary: 'Sync',
  start: { dateTime: '2026-10-20T10:00:00-03:00' },
  end: { dateTime: '2026-10-20T10:30:00-03:00' },
};

export function useGoogleStub() {
  beforeEach(() => {
    calls.length = 0;
    routes.clear();
    vi.stubGlobal('fetch', stubFetch());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });
}

export function errorOf(res: { content: Array<{ text: string }> }) {
  return JSON.parse(res.content[0].text);
}


export function expectInvalid(res: TestResult, pattern?: RegExp) {
  expect(res.isError).toBe(true);
  const { error } = errorOf(res);
  expect(error).toMatch(/^Invalid arguments for /);
  if (pattern) expect(error).toMatch(pattern);
}
