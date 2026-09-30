import * as v from "valibot";
import { MAX_POSITION_S, PING_ID_MAX, PLAYBACK_RATE_MAX, PLAYBACK_RATE_MIN } from "./constants";
import { MemberIdSchema } from "./ids";

/** Server time, ms since epoch. */
export const ServerTimeSchema = v.pipe(v.number(), v.integer(), v.minValue(0));

/** Seconds into the video. Finite, 0–MAX_POSITION_S. */
export const PositionSchema = v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(MAX_POSITION_S));

/** Id the client picks for a `ping`; echoed in the `pong`. */
export const PingIdSchema = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(PING_ID_MAX));

/** Why the playback state last changed. `load` = a new embed started at 0. */
export const PLAYBACK_ACTIONS = ["play", "pause", "seek", "load"] as const;
export type PlaybackAction = (typeof PLAYBACK_ACTIONS)[number];

/**
 * The room's shared playback clock (ADR 0002, ADR 0011). The expected position at
 * server time `t` is `position + (playing ? (t - at) / 1000 * rate : 0)`.
 */
export const PlaybackStateSchema = v.object({
  playing: v.boolean(),
  /** Seconds, true at server time `at`. */
  position: PositionSchema,
  /** Always 1 in M1b; a range now so a shared rate later doesn't break old clients. */
  rate: v.pipe(v.number(), v.finite(), v.minValue(PLAYBACK_RATE_MIN), v.maxValue(PLAYBACK_RATE_MAX)),
  at: ServerTimeSchema,
  /** +1 per accepted change. Clients drop states with an older `rev`. */
  rev: v.pipe(v.number(), v.integer(), v.minValue(0)),
  action: v.picklist(PLAYBACK_ACTIONS),
  /** Who caused the change; null when it came from `POST /rooms/:id/share`. */
  by: v.nullable(MemberIdSchema),
});
export type PlaybackState = v.InferOutput<typeof PlaybackStateSchema>;

/**
 * Playback as sent alongside an embed. Absent only from a pre-M1b server; clients
 * treat absent like null.
 */
export const OptionalPlaybackSchema = v.optional(v.nullable(PlaybackStateSchema));

