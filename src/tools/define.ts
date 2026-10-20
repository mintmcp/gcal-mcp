import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { withGoogleAuth } from "../auth.js";
import { CalendarClient } from "../google/client.js";
import { ToolFailure, type FailurePayload } from "../lib/failure.js";

export const READ_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
export const WRITE_SCOPE = "https://www.googleapis.com/auth/calendar.events";

interface ToolDefinition<S extends z.ZodRawShape, O extends z.ZodRawShape> {
  name: string;
  description: string;
  scope: typeof READ_SCOPE | typeof WRITE_SCOPE;
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
  run, scope, schema, outputSchema, name, description, readOnlyHint = false, destructiveHint = false,
}: ToolDefinition<S, O>): RegisteredTool {
  const input = z.object(schema);
  const authed = withGoogleAuth(scope, async (args: z.infer<z.ZodObject<S>>, { accessToken }) => {
    try {
      const structured = await run(args, new CalendarClient(accessToken));
      return { content: textResult(structured), structuredContent: structured };
    } catch (err) {
      if (err instanceof ToolFailure) return errorResult(err.payload);
      return errorResult({ error: `Unexpected error in ${name}: ${err instanceof Error ? err.message : String(err)}` });
    }
  });
  return {
    name,
    description,
    schema,
    outputSchema,
    readOnlyHint,
    destructiveHint,
    handler: (args) => authed(input.parse(args)),
  };
}
