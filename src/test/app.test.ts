import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp, MCP_PATH } from "../app.js";

const realFetch = globalThis.fetch;
let httpServer: Server;
let url: string;

beforeAll(async () => {
  httpServer = createApp().listen(0, "127.0.0.1");
  await new Promise((resolve) => httpServer.once("listening", resolve));
  url = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}${MCP_PATH}`;
});

afterAll(async () => {
  await new Promise((resolve) => httpServer.close(resolve));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// Slow enough that every request is in flight at once; echoes the caller's
// token as the calendar summary so a response carrying another caller's data fails
function stubSlowCalendar() {
  vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init?: RequestInit) => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const token = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "");
    return new Response(JSON.stringify({ items: [{ id: "c1", summary: token }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }));
}

async function callTool(id: number, token: string) {
  const res = await realFetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "list_calendars", arguments: {} },
    }),
  });
  const body = await res.text();
  // Success is an SSE event; the 500 error path is plain JSON
  const data = body.split("\n").find((line) => line.startsWith("data: "));
  return { status: res.status, message: JSON.parse(data ? data.slice(6) : body) };
}

describe("concurrent MCP requests", () => {
  it("serves overlapping tools/call requests, each with its own caller token", async () => {
    stubSlowCalendar();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => callTool(i + 1, `token-${i + 1}`)),
    );

    results.forEach(({ status, message }, i) => {
      expect(status).toBe(200);
      expect(message.error).toBeUndefined();
      expect(message.id).toBe(i + 1);
      expect(message.result.isError).toBeUndefined();
      expect(message.result.structuredContent.calendars[0].summary).toBe(`token-${i + 1}`);
    });
  });
});
