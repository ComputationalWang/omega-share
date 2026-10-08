import * as v from "valibot";
import { MAX_LISTED_ROOMS, MAX_ROOM_MEMBERS, SEAT_COUNT } from "./constants";
import { RoomIdSchema, RoomTitleSchema } from "./room";

const count = (max: number) => v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(max));

export const RoomSummarySchema = v.pipe(
  v.object({
    id: RoomIdSchema,
    memberCount: count(MAX_ROOM_MEMBERS),
    seatedCount: count(SEAT_COUNT),
    /** Absent from servers before ADR 0028 and for a room that has none. */
    title: v.optional(RoomTitleSchema),
  }),
  v.check((r) => r.seatedCount <= r.memberCount, "more seated than members"),
);
export type RoomSummary = v.InferOutput<typeof RoomSummarySchema>;

/** Body of `GET /rooms`. Server → client, so unknown keys are stripped. At most `MAX_LISTED_ROOMS` rooms. */
export const RoomListResponseSchema = v.object({
  rooms: v.pipe(v.array(RoomSummarySchema), v.maxLength(MAX_LISTED_ROOMS)),
});
export type RoomListResponse = v.InferOutput<typeof RoomListResponseSchema>;
