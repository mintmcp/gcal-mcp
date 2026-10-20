import type { CalendarClient, GoogleErrorContext } from "../google/client.js";
import { toStructuredEvent } from "../lib/event-model.js";
import { withEventTypeHint } from "../lib/event-options.js";

interface EventWrite {
  method: "POST" | "PATCH";
  path: string;
  body: { conferenceData?: unknown; attachments?: unknown };
  sendUpdates?: string;
  ifMatch?: string;
  eventType?: string;
  ctx: GoogleErrorContext;
}

export async function writeEvent(client: CalendarClient, { method, path, body, sendUpdates, ifMatch, eventType, ctx }: EventWrite) {
  try {
    const event = await client.event(path, {
      method,
      query: {
        sendUpdates,
        conferenceDataVersion: body.conferenceData ? "1" : undefined,
        supportsAttachments: body.attachments ? "true" : undefined,
      },
      body,
      ifMatch,
    }, ctx);
    return toStructuredEvent(event);
  } catch (err) {
    throw withEventTypeHint(err, eventType);
  }
}
