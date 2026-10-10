import { QueueAddResponseSchema, type QueueItem } from "@omega/shared";
import * as v from "valibot";
import { type ShareOptions, offContractMessage, postToRoom, roomErrorMessage } from "./share";

export type QueueResult = { readonly ok: true; readonly item: QueueItem } | { readonly ok: false; readonly message: string };

/**
 * "Add to queue": `POST {baseUrl}/rooms/:id/queue` (ADR 0031). Same body, token and errors as a share,
 * plus `queue_full`; the response is parsed against `QueueAddResponseSchema`. Never throws.
 */
export async function addToQueue(options: ShareOptions): Promise<QueueResult> {
  const reply = await postToRoom("queue", options);
  if (!reply.ok) return reply;
  const parsed = v.safeParse(QueueAddResponseSchema, reply.json);
  if (!parsed.success) return { ok: false, message: offContractMessage(options.baseUrl, reply.status) };
  if (parsed.output.ok) return { ok: true, item: parsed.output.item };
  return { ok: false, message: roomErrorMessage(parsed.output.error.code, parsed.output.error.message, reply.retryAfter) };
}
