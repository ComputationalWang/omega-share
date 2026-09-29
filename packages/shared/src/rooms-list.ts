import * as v from "valibot";
import { MAX_ROOM_MEMBERS, SEAT_COUNT } from "./constants";
import { RoomIdSchema } from "./room";

const count = (max: number) => v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(max));

export const RoomSummarySchema = v.pipe(
  v.object({
    id: RoomIdSchema,
    memberCount: count(MAX_ROOM_MEMBERS),
    seatedCount: count(SEAT_COUNT),
  }),
  v.check((r) => r.seatedCount <= r.memberCount, "more seated than members"),
);
export type RoomSummary = v.InferOutput<typeof RoomSummarySchema>;

/** Body of `GET /rooms`. Server → client, so unknown keys are stripped. */
export const RoomListResponseSchema = v.object({ rooms: v.array(RoomSummarySchema) });
export type RoomListResponse = v.InferOutput<typeof RoomListResponseSchema>;
