import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GoogleCalendarTools } from "./tools.js";

const SERVER_NAME = "Google Calendar";
const SERVER_VERSION = "0.1.0";

// Built once: createServer runs per request, and rebuilding every Zod shape
// each time would put that cost on every call
const TOOLS = Object.entries(GoogleCalendarTools.getTools()) as Array<[string, any]>;

export function createServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  for (const [toolName, t] of TOOLS) {
    server.registerTool(
      toolName,
      {
        description: t.description,
        inputSchema: t.schema,
        outputSchema: t.outputSchema,
        annotations: {
          readOnlyHint: t.readOnlyHint ?? false,
          destructiveHint: t.destructiveHint ?? false,
        },
      },
      async (args: Record<string, unknown>) => t.handler(args),
    );
  }

  return server;
}
