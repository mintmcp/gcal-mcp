import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TOOLS } from "./tools/index.js";

const SERVER_NAME = "Google Calendar";
const SERVER_VERSION = "0.1.0";

export function createServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.schema,
        outputSchema: tool.outputSchema,
        annotations: { readOnlyHint: tool.readOnlyHint, destructiveHint: tool.destructiveHint },
      },
      (args) => tool.handler(args),
    );
  }
  return server;
}
