import type { z } from "zod";
import { withGoogleAuth } from "../auth.js";
import { CalendarClient } from "../google/client.js";
import { ToolFailure, type FailurePayload } from "../lib/failure.js";

export const READ_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
export const WRITE_SCOPE = "https://www.googleapis.com/auth/calendar.events";

export interface ToolDefinition<S extends z.ZodRawShape> {
  name: string;
  description: string;
  scope: typeof READ_SCOPE | typeof WRITE_SCOPE;
  schema: S;
  outputSchema: z.ZodRawShape;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  run(args: z.infer<z.ZodObject<S>>, client: CalendarClient): Promise<Record<string, unknown>>;
}

function okResult(structured: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
  };
}

function errorResult(payload: FailurePayload) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    isError: true as const,
  };
}

export function defineTool<S extends z.ZodRawShape>({ run, scope, ...meta }: ToolDefinition<S>) {
  return {
    ...meta,
    handler: withGoogleAuth(scope, async (args: z.infer<z.ZodObject<S>>, { accessToken }) => {
      try {
        return okResult(await run(args, new CalendarClient(accessToken)));
      } catch (err) {
        if (err instanceof ToolFailure) return errorResult(err.payload);
        return errorResult({ error: `Unexpected error in ${meta.name}: ${err instanceof Error ? err.message : String(err)}` });
      }
    }),
  };
}
