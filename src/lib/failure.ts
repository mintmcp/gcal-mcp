export type FailurePayload = Record<string, unknown> & { error: string };

export class ToolFailure extends Error {
  constructor(readonly payload: FailurePayload) {
    super(payload.error);
  }
}

export function fail(error: string, details: Record<string, unknown> = {}): never {
  throw new ToolFailure({ error, ...details });
}
