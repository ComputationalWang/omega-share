import * as v from "valibot";
import { QUEUE_MAX } from "./constants";
import { AnyEmbedSchema } from "./generic-embed";
import { MemberIdSchema, QueueItemIdSchema } from "./ids";

export { QueueItemIdSchema, type QueueItemId } from "./ids";

/**
 * One upcoming item in a room's queue (ADR 0031). `embed` is what the server's share parser made of the
 * `queue-add` url, never the raw string. `by` is the adder's member id (no nickname: clients look it up in
 * `members`); null when the adder is unknown, e.g. after a restart, since the server doesn't persist it.
 */
export const QueueItemSchema = v.object({
  id: QueueItemIdSchema,
  embed: AnyEmbedSchema,
  by: v.nullable(MemberIdSchema),
});
export type QueueItem = v.InferOutput<typeof QueueItemSchema>;

/** Upcoming items in play order, at most QUEUE_MAX, distinct ids. The current item isn't in it. */
export const QueueSchema = v.pipe(
  v.array(QueueItemSchema),
  v.maxLength(QUEUE_MAX),
  v.check((q) => new Set(q.map((i) => i.id)).size === q.length, "duplicate queue item id"),
);
