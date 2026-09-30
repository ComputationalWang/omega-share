import * as v from "valibot";
import { ChatTextSchema, MAX_POSITION_S, SEAT_COUNT, type ClientMessage, type Embed, type Member, type PlaybackState } from "@omega/shared";
import type { ViewState } from "./state";
import { expectedPosition } from "./sync";

export interface SeatView {
  readonly index: number;
  readonly member: Member | null;
  readonly isSelf: boolean;
}

export function seatViews(state: ViewState): SeatView[] {
  const room = state.room;
  const views: SeatView[] = [];
  for (let index = 0; index < SEAT_COUNT; index++) {
    const id = room?.seats[index] ?? null;
    const member = id === null ? null : (room?.members.find((m) => m.id === id) ?? null);
    views.push({ index, member, isSelf: id !== null && id === state.self });
  }
  return views;
}

/** Clicking a seat: sit on a free one, stand up from my own, ignore someone else's. */
export function sitIntent(state: ViewState, seat: number): ClientMessage | null {
  if (state.status !== "open" || state.room === null) return null;
  if (!Number.isInteger(seat) || seat < 0 || seat >= SEAT_COUNT) return null;
  const occupant = state.room.seats[seat] ?? null;
  if (occupant === null) return { type: "sit", seat };
  return occupant === state.self ? { type: "sit", seat: null } : null;
}

export function chatIntent(raw: string): ClientMessage | null {
  const r = v.safeParse(ChatTextSchema, raw);
  return r.success ? { type: "chat", text: r.output } : null;
}

/** What the shared transport acts on: the room's embed and playback (RoomState fits). */
export interface PlaybackTarget {
  readonly embed: Embed | null;
  readonly playback?: PlaybackState | null | undefined;
}

type Control = Extract<ClientMessage, { type: "control" }>;

function control(t: PlaybackTarget, playing: boolean, position: number): Control | null {
  if (t.embed === null || Number.isNaN(position)) return null;
  return { type: "control", videoId: t.embed.videoId, playing, position: Math.min(MAX_POSITION_S, Math.max(0, position)) };
}

/** The shared play/pause key: flip the room, at the room's position now (server clock). */
export function togglePlayIntent(t: PlaybackTarget, serverNowMs: number): Control | null {
  const pb = t.playback ?? null;
  if (pb === null) return null;
  return control(t, !pb.playing, expectedPosition(pb, serverNowMs));
}

/** The shared seek bar: move the room, keeping it playing or paused. */
export function seekIntent(t: PlaybackTarget, position: number): Control | null {
  const pb = t.playback ?? null;
  if (pb === null) return null;
  return control(t, pb.playing, position);
}

/** A play/pause the user made inside the player itself. */
export function playerIntent(t: PlaybackTarget, playing: boolean, position: number): Control | null {
  return control(t, playing, position);
}
