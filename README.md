# gcal-mcp

A Model Context Protocol (MCP) server that exposes Google Calendar to MintMCP
clients. The server speaks streamable HTTP at `/mcp` on port `8000`, runs as a
single module-scope `McpServer` registered once at startup, and reads the
caller's Google OAuth access token from the per-request `Authorization` header
via `AsyncLocalStorage`. It offers a focused, LLM-friendly tool surface
covering calendar discovery, event read/write, and free/busy availability
search.

## Auth contract

Every MCP request must carry the caller's Google OAuth access token as a
bearer header:

```
Authorization: Bearer <google-access-token>
```

That is the only auth input. No tenant/realm IDs, no startup secrets, no
service-account JSON. MintMCP handles the OAuth dance and forwards the access
token per request.

## OAuth scopes

When configuring the MintMCP connector, request these Google scopes:

- `openid`
- `https://www.googleapis.com/auth/userinfo.email`
- `https://www.googleapis.com/auth/userinfo.profile`
- `https://www.googleapis.com/auth/calendar.readonly`
- `https://www.googleapis.com/auth/calendar.events`

The two `calendar.*` scopes are what the tool handlers actually exercise; the
`userinfo` + `openid` triplet is the standard set every Google MintMCP
connector requests for user identification.

## Tools

Six tools across four categories:

- **Discovery** — `list_calendars`
- **Read** — `get_calendar_events`
- **Write** — `create_event`, `update_event`, `delete_event`
- **Availability** — `get_next_availability` (free/busy slot finder)

Every tool declares both `inputSchema` and `outputSchema` and returns
`structuredContent`. Annotations (`readOnlyHint`, `destructiveHint`) are set
where appropriate. See `src/tools.ts` for the full definitions.

## Local build and run

```bash
npm install
npm run build
npm start        # listens on 0.0.0.0:8000
```

For watch-mode development: `npm run dev`.

## Docker

The repo ships a multi-stage `Dockerfile` (`node:22-slim`, non-root `USER
node`, `EXPOSE 8000`). Build and run locally:

```bash
docker build -t gcal-mcp:dev .
docker run --rm -p 8000:8000 gcal-mcp:dev
```

## Deploy to MintMCP

```bash
hosted-cli build-and-push \
  --image mintmcp/gcal-mcp:latest \
  --platform linux/amd64
```

The image MUST be `linux/amd64` — MintMCP's runtime hosts are amd64.
`hosted-cli` uses `docker buildx` under the hood.

## Smoke test

```bash
curl -s http://localhost:8000/healthz
# {"status":"ok"}

curl -s -X POST http://localhost:8000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer fake-token" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1,"params":{}}'
```

A scripted end-to-end smoke test that builds the image, boots it, and asserts
the four endpoints above is available via `npm run smoke`.

## Tests

```bash
npm test         # vitest unit tests for the datetime / attendee helpers
npm run smoke    # full Docker smoke test (requires Docker + python3)
```
