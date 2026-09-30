import type { ErrorCode, MemberId, PlaybackState, RoomState, ServerMessage } from "@omega/shared";
import { systemLine, type SystemLine } from "./controls/sysline";

/** How long a speech bubble stays up. Bubbles are never stored. */
export const BUBBLE_MS = 6000;
/** System lines ("Ana paused") on screen at once, newest last, and how long each stays. */
export const MAX_SYSLINES = 3;
export const SYSLINE_MS = 6000;

export type Status = "idle" | "connecting" | "open" | "reconnecting" | "full";

export interface Bubble {
  readonly memberId: MemberId;
  readonly text: string;
  readonly expiresAt: number;
}

export interface Sysline extends SystemLine {
  /** The playback `rev` it came from; unique per room. */
  readonly id: number;
  readonly expiresAt: number;
}

export interface ViewState {
  readonly status: Status;
  readonly self: MemberId | null;
  readonly room: RoomState | null;
  /** At most one per member, the newest. */
  readonly bubbles: readonly Bubble[];
  /** Chat system lines from playback changes, oldest first. */
  readonly syslines: readonly Sysline[];
  /** A new object per server error, so the UI can show each one. */
  readonly lastError: ErrorNotice | null;
}

export interface ErrorNotice {
  readonly code: ErrorCode;
  readonly at: number;
}

export type ViewEvent =
  | { readonly type: "connecting" }
  | { readonly type: "disconnected" }
  | { readonly type: "server"; readonly msg: ServerMessage; readonly now: number }
  | { readonly type: "tick"; readonly now: number };

export const initialState: ViewState = { status: "idle", self: null, room: null, bubbles: [], syslines: [], lastError: null };

const hasMember = (room: RoomState, id: MemberId): boolean => room.members.some((m) => m.id === id);

function withRoom(state: ViewState, update: (room: RoomState) => RoomState | null): ViewState {
  if (state.room === null) return state;
  const next = update(state.room);
  return next === null ? state : { ...state, room: next };
}

/** Replace the room's playback and say so in chat. Room keeps its seats/members objects. */
function withPlayback(state: ViewState, room: RoomState, pb: PlaybackState | null, now: number, patch: Partial<RoomState> = {}): ViewState {
  const next: RoomState = { ...room, ...patch, playback: pb };
  const line = pb === null ? null : systemLine(pb, room.members, state.self);
  if (pb === null || line === null) return { ...state, room: next };
  const kept = state.syslines.length >= MAX_SYSLINES ? state.syslines.slice(state.syslines.length - MAX_SYSLINES + 1) : state.syslines;
  return { ...state, room: next, syslines: [...kept, { ...line, id: pb.rev, expiresAt: now + SYSLINE_MS }] };
}

function onServer(state: ViewState, msg: ServerMessage, now: number): ViewState {
  switch (msg.type) {
    case "snapshot":
      return { ...state, status: "open", self: msg.self, room: msg.room, bubbles: [], syslines: [], lastError: null };
    case "room-full":
      return { ...initialState, status: "full" };
    case "error":
      return { ...state, lastError: { code: msg.code, at: now } };
    case "member-joined":
      return withRoom(state, (room) =>
        hasMember(room, msg.member.id) ? null : { ...room, members: [...room.members, msg.member] },
      );
    case "member-left": {
      const next = withRoom(state, (room) =>
        hasMember(room, msg.memberId)
          ? {
              ...room,
              members: room.members.filter((m) => m.id !== msg.memberId),
              seats: room.seats.map((s) => (s === msg.memberId ? null : s)),
            }
          : null,
      );
      return next === state ? state : { ...next, bubbles: next.bubbles.filter((b) => b.memberId !== msg.memberId) };
    }
    case "seat-changed":
      return withRoom(state, (room) => {
        if (!hasMember(room, msg.memberId)) return null;
        const seats = room.seats.map((s) => (s === msg.memberId ? null : s));
        if (msg.seat !== null) seats[msg.seat] = msg.memberId;
        return { ...room, seats };
      });
    case "embed-changed":
      if (state.room === null) return state;
      return withPlayback(state, state.room, msg.embed === null ? null : (msg.playback ?? null), now, { embed: msg.embed });
    case "playback": {
      const room = state.room;
      if (room === null) return state;
      if (room.embed === null) return state;
      const cur = room.playback ?? null;
      if (cur !== null && msg.playback.rev <= cur.rev) return state;
      return withPlayback(state, room, msg.playback, now);
    }
    case "chat": {
      if (state.room === null || !hasMember(state.room, msg.memberId)) return state;
      const bubble: Bubble = { memberId: msg.memberId, text: msg.text, expiresAt: now + BUBBLE_MS };
      return { ...state, bubbles: [...state.bubbles.filter((b) => b.memberId !== msg.memberId), bubble] };
    }
    case "pong":
      return state;
  }
}

export function reduce(state: ViewState, event: ViewEvent): ViewState {
  switch (event.type) {
    case "server":
      return onServer(state, event.msg, event.now);
    case "connecting":
      return state.status === "full" ? state : { ...state, status: "connecting" };
    case "disconnected":
      return state.status === "full" ? state : { ...state, status: "reconnecting", bubbles: [] };
    case "tick": {
      const kept = state.bubbles.filter((b) => b.expiresAt > event.now);
      const lines = state.syslines.filter((l) => l.expiresAt > event.now);
      if (kept.length === state.bubbles.length && lines.length === state.syslines.length) return state;
      return {
        ...state,
        bubbles: kept.length === state.bubbles.length ? state.bubbles : kept,
        syslines: lines.length === state.syslines.length ? state.syslines : lines,
      };
    }
  }
}

/** When the next bubble or system line expires, or null if there are none. */
export function nextExpiry(state: ViewState): number | null {
  let min: number | null = null;
  for (const b of state.bubbles) if (min === null || b.expiresAt < min) min = b.expiresAt;
  for (const l of state.syslines) if (min === null || l.expiresAt < min) min = l.expiresAt;
  return min;
}

export interface Screen {
  readonly stage: boolean;
  readonly chat: boolean;
  readonly full: boolean;
}

/** Which room-screen regions are laid out. The stage wrap has a fixed height, so it leaves the flow when not in a room. */
export function screen(state: ViewState): Screen {
  const inRoom = state.room !== null && state.status !== "full";
  return { stage: inRoom, chat: inRoom, full: state.status === "full" };
}
