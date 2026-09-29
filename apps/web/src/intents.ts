import * as v from "valibot";
import { ChatTextSchema, SEAT_COUNT, type ClientMessage, type Member } from "@omega/shared";
import type { ViewState } from "./state";

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
