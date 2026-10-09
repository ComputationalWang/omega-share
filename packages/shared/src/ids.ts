import * as v from "valibot";

/** Server-assigned, opaque. */
export const MemberIdSchema = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{1,64}$/));
export type MemberId = v.InferOutput<typeof MemberIdSchema>;

/** Server-assigned, opaque: one per item that is or was in a room's queue, the current one included (ADR 0031). */
export const QueueItemIdSchema = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{1,32}$/));
export type QueueItemId = v.InferOutput<typeof QueueItemIdSchema>;
