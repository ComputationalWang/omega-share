import type { ErrorCode, MemberId, PlaybackState, RoomState, ServerMessage } from "@omega/shared";
import { systemLine, type SystemLine } from "./controls/sysline";

/** How long a speech bubble stays up. Bubbles are never stored. */
export const BUBBLE_MS = 6000;
/** System lines ("Ana paused") on screen at once, newest last, and how long each stays. */
export const MAX_SYSLINES = 3;
export const SYSLINE_MS = 6000;

/** How long chat stays in cooldown after a `rate_limited` that carries no `retryAfterMs` (pre-M3 server). */
export const CHAT_COOLDOWN_DEFAULT_MS = 1000;

export type Status = "idle" | "connecting" | "open" | "reconnecting" | "full" | "refused";

/** Why the server refused our join (ADR 0016 §4). The connection has stopped; the user has to act. */
export type Refusal = "nickname_taken" | "too_many_members";

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
  /** Set with status "refused". */
  readonly refusal: Refusal | null;
  /** Client time (the `now` of the events, ms) until which the server asked us to hold off (`rate_limited`); 0 = none. */
  readonly cooldownUntil: number;
  /**
   * Other members whose player is catching up (ADR 0019, advisory). Kept outside `room.members`
   * so a toggle doesn't redraw the scene. My own tag uses the local playback view instead.
   */
  readonly catching: readonly MemberId[];
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

export const initialState: ViewState = { status: "idle", self: null, room: null, bubbles: [], syslines: [], lastError: null, refusal: null, cooldownUntil: 0, catching: [] };

/** Terminal until the user acts: the connection won't reconnect, so its events don't change the status. */
const stopped = (s: ViewState): boolean => s.status === "full" || s.status === "refused";

/** True while the server's `rate_limited` hint says to hold off sending chat. */
export function coolingDown(state: ViewState, now: number): boolean {
  return now < state.cooldownUntil;
}

/** True while the server says this member is catching up. */
export function catchingUp(state: ViewState, id: MemberId): boolean {
  return state.catching.includes(id);
}

function withCatching(state: ViewState, id: MemberId, on: boolean): ViewState {
  if (catchingUp(state, id) === on) return state;
  return { ...state, catching: on ? [...state.catching, id] : state.catching.filter((m) => m !== id) };
}

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
      return {
        ...state,
        status: "open",
        self: msg.self,
        room: msg.room,
        bubbles: [],
        syslines: [],
        lastError: null,
        catching: msg.room.members.filter((m) => m.catching === true).map((m) => m.id),
      };
    case "room-full":
      return { ...initialState, status: "full" };
    case "error": {
      const lastError = { code: msg.code, at: now };
      if (msg.code === "nickname_taken" || msg.code === "too_many_members") {
        // Only a join is refused (ADR 0016 §4). Once this connection is in, the connection ignores it; so do we.
        if (state.status === "open") return { ...state, lastError };
        return { ...initialState, status: "refused", refusal: msg.code, lastError };
      }
      if (msg.code !== "rate_limited") return { ...state, lastError };
      const until = now + (msg.retryAfterMs ?? CHAT_COOLDOWN_DEFAULT_MS);
      return { ...state, lastError, cooldownUntil: Math.max(state.cooldownUntil, until) };
    }
    case "member-joined": {
      const next = withRoom(state, (room) =>
        hasMember(room, msg.member.id) ? null : { ...room, members: [...room.members, msg.member] },
      );
      return next === state ? state : withCatching(next, msg.member.id, msg.member.catching === true);
    }
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
      return next === state ? state : withCatching({ ...next, bubbles: next.bubbles.filter((b) => b.memberId !== msg.memberId) }, msg.memberId, false);
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
    case "member-status":
      return state.room === null || !hasMember(state.room, msg.memberId) ? state : withCatching(state, msg.memberId, msg.catching);
    case "pong":
    // The site doesn't send owner edits yet (ADR 0028); W1/X1 apply these.
    case "layout-changed":
    case "title-changed":
      return state;
  }
}

export function reduce(state: ViewState, event: ViewEvent): ViewState {
  switch (event.type) {
    case "server":
      return onServer(state, event.msg, event.now);
    case "connecting":
      return stopped(state) ? state : { ...state, status: "connecting" };
    case "disconnected":
      return stopped(state) ? state : { ...state, status: "reconnecting", bubbles: [] };
    case "tick": {
      const kept = state.bubbles.filter((b) => b.expiresAt > event.now);
      const lines = state.syslines.filter((l) => l.expiresAt > event.now);
      const cooled = state.cooldownUntil !== 0 && state.cooldownUntil <= event.now;
      if (kept.length === state.bubbles.length && lines.length === state.syslines.length && !cooled) return state;
      return {
        ...state,
        bubbles: kept.length === state.bubbles.length ? state.bubbles : kept,
        syslines: lines.length === state.syslines.length ? state.syslines : lines,
        cooldownUntil: cooled ? 0 : state.cooldownUntil,
      };
    }
  }
}

/** When the next bubble, system line or chat cooldown expires, or null if there are none. */
export function nextExpiry(state: ViewState): number | null {
  let min: number | null = state.cooldownUntil === 0 ? null : state.cooldownUntil;
  for (const b of state.bubbles) if (min === null || b.expiresAt < min) min = b.expiresAt;
  for (const l of state.syslines) if (min === null || l.expiresAt < min) min = l.expiresAt;
  return min;
}

export interface Screen {
  readonly stage: boolean;
  readonly chat: boolean;
  readonly full: boolean;
  readonly refused: Refusal | null;
}

/** Which room-screen regions are laid out. The stage wrap has a fixed height, so it leaves the flow when not in a room. */
export function screen(state: ViewState): Screen {
  const inRoom = state.room !== null && !stopped(state);
  return { stage: inRoom, chat: inRoom, full: state.status === "full", refused: state.status === "refused" ? state.refusal : null };
}
