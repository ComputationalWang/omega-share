import * as v from "valibot";
import { MAX_LISTED_ROOMS, MAX_ROOM_MEMBERS, SEAT_COUNT } from "./constants";
import { TwitchLoginSchema, TwitchVodIdSchema, VimeoIdSchema, YoutubeVideoIdSchema } from "./embed";
import type { AnyEmbed } from "./generic-embed";
import { RoomIdSchema, RoomTitleSchema } from "./room";

const count = (max: number) => v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(max));

/** A Twitch VOD as `GET /rooms` names it: its twitch.tv path, `videos/<id>`. "videos" is a reserved login, so it never collides with a channel. */
const TWITCH_VOD_PATH = /^videos\/([1-9][0-9]{0,11})$/;

/**
 * What a listed room plays (OME-1625, ADR 0056): the provider and the video's id, never a title or URL. YouTube and
 * Vimeo give the video id; Twitch the channel login (live) or `videos/<id>` (VOD). Unknown keys are stripped.
 */
export const NowPlayingSchema = v.variant("provider", [
  v.object({ provider: v.literal("youtube"), id: YoutubeVideoIdSchema }),
  v.object({ provider: v.literal("vimeo"), id: VimeoIdSchema }),
  v.object({
    provider: v.literal("twitch"),
    id: v.pipe(
      v.string(),
      v.check((id) => v.is(TwitchLoginSchema, id) || v.is(TwitchVodIdSchema, TWITCH_VOD_PATH.exec(id)?.[1]), "not a channel or videos/<id>"),
    ),
  }),
]);
export type NowPlaying = v.InferOutput<typeof NowPlayingSchema>;

/** `nowPlaying` for a room's current embed: public synced videos only, so an unlisted Vimeo (with a hash) or a generic embed gives none. */
export function nowPlayingOf(embed: AnyEmbed | null): NowPlaying | undefined {
  switch (embed?.provider) {
    case "youtube":
      return { provider: "youtube", id: embed.videoId };
    case "vimeo":
      return embed.hash === null ? { provider: "vimeo", id: embed.videoId } : undefined;
    case "twitch":
      return { provider: "twitch", id: embed.kind === "live" ? embed.channel : `videos/${embed.videoId}` };
    case "generic":
    case undefined:
      return undefined;
  }
}

export const RoomSummarySchema = v.pipe(
  v.object({
    id: RoomIdSchema,
    memberCount: count(MAX_ROOM_MEMBERS),
    seatedCount: count(SEAT_COUNT),
    /** Absent from servers before ADR 0028 and for a room that has none. */
    title: v.optional(RoomTitleSchema),
    /** Members whose tab is visible (not `away`), OME-1625. Absent from a server before ADR 0056. */
    watchingCount: v.optional(count(MAX_ROOM_MEMBERS)),
    /** The room's current video, `nowPlayingOf` its embed (ADR 0056). Absent when there is none, or it is unlisted or generic. */
    nowPlaying: v.optional(NowPlayingSchema),
  }),
  v.check((r) => r.seatedCount <= r.memberCount, "more seated than members"),
  v.check((r) => (r.watchingCount ?? 0) <= r.memberCount, "more watching than members"),
);
export type RoomSummary = v.InferOutput<typeof RoomSummarySchema>;

/** Body of `GET /rooms`. Server → client, so unknown keys are stripped. At most `MAX_LISTED_ROOMS` rooms. Private rooms are never listed. */
export const RoomListResponseSchema = v.object({
  rooms: v.pipe(v.array(RoomSummarySchema), v.maxLength(MAX_LISTED_ROOMS)),
});
export type RoomListResponse = v.InferOutput<typeof RoomListResponseSchema>;
