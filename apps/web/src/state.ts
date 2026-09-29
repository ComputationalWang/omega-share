import type { ErrorCode, MemberId, RoomState, ServerMessage } from "@omega/shared";

/** How long a speech bubble stays up. Bubbles are never stored. */
export const BUBBLE_MS = 6000;

export type Status = "idle" | "connecting" | "open" | "reconnecting" | "full";

export interface Bubble {
  readonly memberId: MemberId;
  readonly text: string;
  readonly expiresAt: number;
}

export interface ViewState {
  readonly status: Status;
  readonly self: MemberId | null;
  readonly room: RoomState | null;
  /** At most one per member, the newest. */
  readonly bubbles: readonly Bubble[];
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

export const initialState: ViewState = { status: "idle", self: null, room: null, bubbles: [], lastError: null };

const hasMember = (room: RoomState, id: MemberId): boolean => room.members.some((m) => m.id === id);

function withRoom(state: ViewState, update: (room: RoomState) => RoomState | null): ViewState {
  if (state.room === null) return state;
  const next = update(state.room);
  return next === null ? state : { ...state, room: next };
}

function onServer(state: ViewState, msg: ServerMessage, now: number): ViewState {
  switch (msg.type) {
    case "snapshot":
      return { ...state, status: "open", self: msg.self, room: msg.room, bubbles: [], lastError: null };
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
      return withRoom(state, (room) => ({ ...room, embed: msg.embed }));
    case "chat": {
      if (state.room === null || !hasMember(state.room, msg.memberId)) return state;
      const bubble: Bubble = { memberId: msg.memberId, text: msg.text, expiresAt: now + BUBBLE_MS };
      return { ...state, bubbles: [...state.bubbles.filter((b) => b.memberId !== msg.memberId), bubble] };
    }
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
      return kept.length === state.bubbles.length ? state : { ...state, bubbles: kept };
    }
  }
}

/** When the next bubble expires, or null if there are none. */
export function nextExpiry(state: ViewState): number | null {
  let min: number | null = null;
  for (const b of state.bubbles) if (min === null || b.expiresAt < min) min = b.expiresAt;
  return min;
}
