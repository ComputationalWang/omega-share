import * as v from "valibot";
import { COUNTDOWN_MAX_MS, MAX_POSITION_S, PING_ID_MAX, PLAYBACK_RATE_MAX, PLAYBACK_RATE_MIN } from "./constants";
import { MemberIdSchema } from "./ids";

/** Server time, ms since epoch. */
export const ServerTimeSchema = v.pipe(v.number(), v.integer(), v.minValue(0));

/** Seconds into the video. Finite, 0–MAX_POSITION_S. */
export const PositionSchema = v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(MAX_POSITION_S));

/** Id the client picks for a `ping`; echoed in the `pong`. */
export const PingIdSchema = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(PING_ID_MAX));

/** Whole seconds into the video a share or queue item starts at (OME-1625): an integer, 0–MAX_POSITION_S. */
export const StartSecondsSchema = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(MAX_POSITION_S));

/** Milliseconds into the video, as the server's room clock had it (a reaction's `mediaMs`): an integer, 0–MAX_POSITION_S × 1000. */
export const MediaMsSchema = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(MAX_POSITION_S * 1000));

/** Why the playback state last changed. `load` = a new embed started at 0, or at its item's `startSeconds`. */
export const PLAYBACK_ACTIONS = ["play", "pause", "seek", "load"] as const;
export type PlaybackAction = (typeof PLAYBACK_ACTIONS)[number];

/**
 * The room's shared playback clock (ADR 0002, ADR 0011). The expected position at
 * server time `t` is `position + (playing ? (t - at) / 1000 * rate : 0)`.
 * With `startAt` (a countdown play, ADR 0056) the clock holds at `position` until `startAt`, then runs from there:
 * `position + (t - startAt) / 1000 * rate` for `t >= startAt`.
 */
export const PlaybackStateSchema = v.pipe(v.object({
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
  /** A shared 3-2-1 (OME-1625): server time the room starts playing. Only on a `play`, `at`..`at` + COUNTDOWN_MAX_MS. */
  startAt: v.optional(ServerTimeSchema),
}),
  v.check((p) => p.startAt === undefined || (p.playing && p.action === "play" && p.startAt >= p.at && p.startAt - p.at <= COUNTDOWN_MAX_MS), "startAt off a countdown play"),
);
export type PlaybackState = v.InferOutput<typeof PlaybackStateSchema>;

/**
 * Playback as sent alongside an embed. Absent only from a pre-M1b server; clients
 * treat absent like null.
 */
export const OptionalPlaybackSchema = v.optional(v.nullable(PlaybackStateSchema));

