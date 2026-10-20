import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { NOT_CONNECTED_MESSAGE, getAccessToken } from "../auth.js";
import { CalendarClient } from "../google/client.js";
import { ToolFailure, fail, type FailurePayload } from "../lib/failure.js";

interface ToolDefinition<S extends z.ZodRawShape, O extends z.ZodRawShape> {
  name: string;
  description: string;
  schema: S;
  outputSchema: O;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  run(args: z.infer<z.ZodObject<S>>, client: CalendarClient): Promise<z.infer<z.ZodObject<O>>>;
}

export interface RegisteredTool {
  name: string;
  description: string;
  schema: z.ZodRawShape;
  outputSchema: z.ZodRawShape;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  handler(args: unknown): Promise<CallToolResult>;
}

function textResult(payload: Record<string, unknown>): CallToolResult["content"] {
  return [{ type: "text", text: JSON.stringify(payload, null, 2) }];
}

function errorResult(payload: FailurePayload): CallToolResult {
  return { content: textResult(payload), isError: true };
}

export function defineTool<S extends z.ZodRawShape, O extends z.ZodRawShape>({
  run, schema, outputSchema, name, description, readOnlyHint = false, destructiveHint = false,
}: ToolDefinition<S, O>): RegisteredTool {
  const input = z.object(schema);
  return {
    name,
    description,
    schema,
    outputSchema,
    readOnlyHint,
    destructiveHint,
    async handler(args) {
      try {
        const accessToken = getAccessToken() || fail(NOT_CONNECTED_MESSAGE, { status: 401 });
        const structured = await run(input.parse(args), new CalendarClient(accessToken));
        return { content: textResult(structured), structuredContent: structured };
      } catch (err) {
        if (err instanceof ToolFailure) return errorResult(err.payload);
        if (err instanceof z.ZodError) return errorResult({ error: `Invalid arguments for ${name}: ${z.prettifyError(err)}` });
        return errorResult({ error: `Unexpected error in ${name}: ${err instanceof Error ? err.message : String(err)}` });
      }
    },
  };
}
