import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestHandler } from "express";
import { jsonRpcError, messagesOf, responseIdFor } from "./jsonrpc.js";

export interface RequestContext {
  accessToken: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function getAccessToken(): string | undefined {
  return requestContext.getStore()?.accessToken;
}

export const NOT_CONNECTED_MESSAGE =
  "Google Calendar is not connected. Authorize the Google Calendar connector for this user, then retry. " +
  "(No access token reached the server: MintMCP forwards the user's OAuth token as an " +
  "Authorization: Bearer header, and that header was missing or empty.)";

export function bearerTokenFromHeader(header: string | undefined): string {
  return header?.match(/^Bearer\s+(.*)$/i)?.[1].trim() ?? "";
}

export function requiresAccessToken(body: unknown): boolean {
  return messagesOf(body).some(
    (message) =>
      message.method === "tools/list" || message.method === "tools/call",
  );
}

// initialize stays open because MintMCP uses it for Fly readiness probes.
export const requireAccessToken: RequestHandler = (req, res, next) => {
  const accessToken = bearerTokenFromHeader(req.header("authorization"));
  if (!accessToken && requiresAccessToken(req.body)) {
    res
      .status(401)
      .set(
        "WWW-Authenticate",
        'Bearer realm="gcal-mcp", error="invalid_token", error_description="Missing Google access token"',
      )
      .json(jsonRpcError(-32001, NOT_CONNECTED_MESSAGE, responseIdFor(messagesOf(req.body))));
    return;
  }
  requestContext.run({ accessToken }, next);
};
