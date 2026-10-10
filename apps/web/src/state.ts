import { DEFAULT_CONTROL_POLICY, type ControlPolicy, type ErrorCode, type MemberId, type PlaybackState, type RoomState, type ServerMessage } from "@omega/shared";
import { FLOAT_PER_SPEAKER } from "./bubbles/floats";
import { mutedLine, policyLine, systemLine, type SystemLine } from "./controls/sysline";

/** How long a speech bubble stays up. Bubbles are never stored. */
export const BUBBLE_MS = 6000;
/** System lines ("Ana paused") on screen at once, newest last, and how long each stays. */
export const MAX_SYSLINES = 3;
export const SYSLINE_MS = 6000;

/** How long chat stays in cooldown after a `rate_limited` that carries no `retryAfterMs` (pre-M3 server). */
export const CHAT_COOLDOWN_DEFAULT_MS = 1000;

/**
 * `not-found` (OME-768): a room this page never got into answered that it's gone (4004), taken down (4006), or private
 * without a working key (`invite_required`). One screen for all of them, so the page never tells a private room from no room.
 */
export type Status = "idle" | "connecting" | "open" | "reconnecting" | "full" | "refused" | "closed" | "taken-down" | "kicked" | "not-found";

/** Why the server refused our join (ADR 0016 §4). The connection has stopped; the user has to act. A refused invite is `not-found`. */
export type Refusal = "nickname_taken" | "too_many_members";

export interface Bubble {
  /** The message's own key, rising for the life of the page (OME-809): the stage hands each id to the floats once. */
  readonly id: number;
  readonly memberId: MemberId;
  readonly text: string;
  readonly expiresAt: number;
}

export interface Sysline extends SystemLine {
  /** The playback `rev` it came from (unique per room), or a negative sequence for moderation lines. */
  readonly id: number;
  readonly expiresAt: number;
}

export interface ViewState {
  readonly status: Status;
  readonly self: MemberId | null;
  readonly room: RoomState | null;
  /** A member's last FLOAT_PER_SPEAKER lines, oldest first. Kept by message, so two lines landing before one render both float. */
  readonly bubbles: readonly Bubble[];
  /** The last bubble id handed out. Never reset, so an id is never reused while the stage may still remember it. */
  readonly bubbleSeq: number;
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
  /** I joined with this room's owner token (`snapshot.owner`, ADR 0028): the layout editor is offered. */
  readonly owner: boolean;
  /** The room's title from the snapshot or the last `title-changed`; null while it has none (or a pre-M5 server). */
  readonly title: string | null;
  /** Members the owner muted (ADR 0030). Like `catching`, kept outside `room.members` so a mute doesn't redraw the scene. */
  readonly muted: readonly MemberId[];
  /** Moderation lines so far: their sysline ids are the negatives, so they never collide with a playback `rev`. */
  readonly modLines: number;
  /** With status "kicked": client time (Date.now ms) when the rejoin cooldown ends; null = unknown (a bounce). */
  readonly kickedUntil: number | null;
}

/** What the room's stage draws (stage.ts): the page's own state, or the slice the room tab mirrors to its room window (OME-600). */
export type StageState = Pick<ViewState, "status" | "self" | "room" | "bubbles" | "syslines" | "catching">;

export interface ErrorNotice {
  readonly code: ErrorCode;
  readonly at: number;
}

export type ViewEvent =
  | { readonly type: "connecting" }
  | { readonly type: "disconnected" }
  /** 4004, or 4006 with `takenDown` (ADR 0033 §6). */
  | { readonly type: "room-closed"; readonly takenDown?: true }
  /** 4005 (ADR 0030); `until` is when the rejoin cooldown ends, client ms, or null if we can't know (a bounce). */
  | { readonly type: "kicked"; readonly until: number | null }
  | { readonly type: "server"; readonly msg: ServerMessage; readonly now: number }
  | { readonly type: "tick"; readonly now: number }
  /** I hid this member for myself (OME-769): their bubbles go now; their later lines never get here (room-events.ts). */
  | { readonly type: "hide"; readonly memberId: MemberId };

export const initialState: ViewState = { status: "idle", self: null, room: null, bubbles: [], bubbleSeq: 0, syslines: [], lastError: null, refusal: null, cooldownUntil: 0, catching: [], owner: false, title: null, muted: [], modLines: 0, kickedUntil: null };

/** Terminal until the user acts: the connection won't reconnect, so its events don't change the status. */
const stopped = (s: ViewState): boolean => s.status === "full" || s.status === "refused" || s.status === "closed" || s.status === "taken-down" || s.status === "kicked" || s.status === "not-found";

/** True while the server's `rate_limited` hint says to hold off sending chat. */
export function coolingDown(state: ViewState, now: number): boolean {
  return now < state.cooldownUntil;
}

/** True while the server says this member is catching up. */
export function catchingUp(state: Pick<ViewState, "catching">, id: MemberId): boolean {
  return state.catching.includes(id);
}

function withCatching(state: ViewState, id: MemberId, on: boolean): ViewState {
  if (catchingUp(state, id) === on) return state;
  return { ...state, catching: on ? [...state.catching, id] : state.catching.filter((m) => m !== id) };
}

/** True while the owner has this member's chat muted (ADR 0030). */
export function isMuted(state: ViewState, id: MemberId): boolean {
  return state.muted.includes(id);
}

function withMuted(state: ViewState, id: MemberId, on: boolean): ViewState {
  if (isMuted(state, id) === on) return state;
  return { ...state, muted: on ? [...state.muted, id] : state.muted.filter((m) => m !== id) };
}

/** Who controls playback (ADR 0030); a pre-M6 server sends none. */
export function controlPolicy(state: ViewState): ControlPolicy {
  return state.room?.controlPolicy ?? DEFAULT_CONTROL_POLICY;
}

/** The shared transport is held for me: only the owner controls playback, and I'm not the owner. */
export function controlHeld(state: ViewState): boolean {
  return !state.owner && controlPolicy(state) === "owner";
}

function pushLine(state: ViewState, line: SystemLine, id: number, now: number): ViewState["syslines"] {
  const kept = state.syslines.length >= MAX_SYSLINES ? state.syslines.slice(state.syslines.length - MAX_SYSLINES + 1) : state.syslines;
  return [...kept, { ...line, id, expiresAt: now + SYSLINE_MS }];
}

/** A moderation line in the log, keyed by the next negative id. */
function withModLine(state: ViewState, line: SystemLine, now: number): ViewState {
  const modLines = state.modLines + 1;
  return { ...state, modLines, syslines: pushLine(state, line, -modLines, now) };
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
  return { ...state, room: next, syslines: pushLine(state, line, pb.rev, now) };
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
        muted: msg.room.members.filter((m) => m.muted === true).map((m) => m.id),
        owner: msg.owner === true,
        // An untitled snapshot (an older server, a rejoin) keeps the title we already know.
        title: msg.room.title ?? state.title,
      };
    case "room-full":
      return { ...initialState, bubbleSeq: state.bubbleSeq, status: "full" };
    case "error": {
      const lastError = { code: msg.code, at: now };
      if (msg.code === "nickname_taken" || msg.code === "too_many_members" || msg.code === "invite_required") {
        // Only a join is refused (ADR 0016 §4). Once this connection is in, the connection ignores it; so do we.
        if (state.status === "open") return { ...state, lastError };
        // No notice either: its words would say the room is private.
        if (msg.code === "invite_required") return { ...initialState, bubbleSeq: state.bubbleSeq, status: "not-found" };
        return { ...initialState, bubbleSeq: state.bubbleSeq, status: "refused", refusal: msg.code, lastError };
      }
      if (msg.code !== "rate_limited") return { ...state, lastError };
      const until = now + (msg.retryAfterMs ?? CHAT_COOLDOWN_DEFAULT_MS);
      return { ...state, lastError, cooldownUntil: Math.max(state.cooldownUntil, until) };
    }
    case "member-joined": {
      const next = withRoom(state, (room) =>
        hasMember(room, msg.member.id) ? null : { ...room, members: [...room.members, msg.member] },
      );
      return next === state ? state : withMuted(withCatching(next, msg.member.id, msg.member.catching === true), msg.member.id, msg.member.muted === true);
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
      return next === state ? state : withMuted(withCatching({ ...next, bubbles: next.bubbles.filter((b) => b.memberId !== msg.memberId) }, msg.memberId, false), msg.memberId, false);
    }
    case "seat-changed":
      return withRoom(state, (room) => {
        if (!hasMember(room, msg.memberId)) return null;
        const seats = room.seats.map((s) => (s === msg.memberId ? null : s));
        if (msg.seat !== null) seats[msg.seat] = msg.memberId;
        return { ...room, seats };
      });
    case "embed-changed": {
      if (state.room === null) return state;
      // The current item's id (ADR 0031) goes with its embed: a share without one clears it.
      const room: RoomState = { ...state.room };
      if (msg.itemId === undefined || msg.embed === null) delete room.itemId;
      else room.itemId = msg.itemId;
      return withPlayback(state, room, msg.embed === null ? null : (msg.playback ?? null), now, { embed: msg.embed });
    }
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
      const id = state.bubbleSeq + 1;
      const bubble: Bubble = { id, memberId: msg.memberId, text: msg.text, expiresAt: now + BUBBLE_MS };
      // 2 per speaker: past that, their oldest goes.
      let theirs = 0;
      for (const b of state.bubbles) if (b.memberId === msg.memberId) theirs++;
      let drop = theirs - FLOAT_PER_SPEAKER + 1;
      const kept = drop > 0 ? state.bubbles.filter((b) => b.memberId !== msg.memberId || drop-- <= 0) : state.bubbles;
      return { ...state, bubbleSeq: id, bubbles: [...kept, bubble] };
    }
    case "member-status":
      return state.room === null || !hasMember(state.room, msg.memberId) ? state : withCatching(state, msg.memberId, msg.catching);
    // Owner edits (ADR 0028): seats keep their indices, so only the layout changes; the scene follows it (room.ts).
    case "layout-changed":
      return withRoom(state, (room) => ({ ...room, layout: msg.layout }));
    case "title-changed":
      return state.room === null ? state : { ...state, title: msg.title };
    case "pong":
    // Drawn by W-emote; never part of the view state (OME-413).
    case "emoted":
      return state;
    // Owner moderation (ADR 0030). Everyone gets `member-muted`, but only the muted member's log says so; everyone's says the policy.
    case "member-muted": {
      if (state.room === null || !hasMember(state.room, msg.memberId)) return state;
      const next = withMuted(state, msg.memberId, msg.muted);
      return next === state || msg.memberId !== state.self ? next : withModLine(next, mutedLine(msg.muted), now);
    }
    case "control-policy-changed": {
      const room = state.room;
      if (room === null) return state;
      const next = { ...state, room: { ...room, controlPolicy: msg.policy } };
      return withModLine(next, policyLine(msg.policy, msg.by, room.members, state.self), now);
    }
    // The whole upcoming list (ADR 0031); members and seats keep their objects, so the scene isn't redrawn.
    case "queue-changed":
      return withRoom(state, (room) => ({ ...room, queue: msg.queue }));
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
    case "room-closed":
      // Never in it on this page (no room yet): to us it doesn't exist. A room we were in says how it ended.
      if (state.room === null) return { ...initialState, bubbleSeq: state.bubbleSeq, status: "not-found" };
      return { ...initialState, bubbleSeq: state.bubbleSeq, status: event.takenDown === true ? "taken-down" : "closed" };
    case "kicked":
      return { ...initialState, bubbleSeq: state.bubbleSeq, status: "kicked", kickedUntil: event.until };
    case "hide": {
      const kept = state.bubbles.filter((b) => b.memberId !== event.memberId);
      return kept.length === state.bubbles.length ? state : { ...state, bubbles: kept };
    }
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
  /** The room was deleted or collected (4004), or taken down by the operators after a report (4006, ADR 0033 §6). */
  readonly closed: false | "deleted" | "taken-down";
  /** The owner removed me (4005, ADR 0030). */
  readonly kicked: boolean;
  /** A room this page never got into is gone, taken down or keyless-private (OME-768): "Room not found". */
  readonly notFound: boolean;
}

/** Which room-screen regions are laid out. The stage wrap has a fixed height, so it leaves the flow when not in a room. */
export function screen(state: ViewState): Screen {
  const inRoom = state.room !== null && !stopped(state);
  return { stage: inRoom, chat: inRoom, full: state.status === "full", refused: state.status === "refused" ? state.refusal : null, closed: state.status === "closed" ? "deleted" : state.status === "taken-down" ? "taken-down" : false, kicked: state.status === "kicked", notFound: state.status === "not-found" };
}
