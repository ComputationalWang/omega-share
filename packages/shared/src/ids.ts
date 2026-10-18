import * as v from "valibot";
import { ROOM_ID_MAX_LENGTH } from "./constants";

/** Here, not in room.ts, so layout.ts (a door's target, ADR 0054) can use it without an import cycle. */
export const RoomIdSchema = v.pipe(v.string(), v.regex(new RegExp(`^[a-z0-9-]{1,${String(ROOM_ID_MAX_LENGTH)}}$`)));
export type RoomId = v.InferOutput<typeof RoomIdSchema>;

/** Server-assigned, opaque. */
export const MemberIdSchema = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{1,64}$/));
export type MemberId = v.InferOutput<typeof MemberIdSchema>;

/** Server-assigned, opaque: one per item that is or was in a room's queue, the current one included (ADR 0031). */
export const QueueItemIdSchema = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{1,32}$/));
export type QueueItemId = v.InferOutput<typeof QueueItemIdSchema>;
