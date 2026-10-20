// /conga (OME-1564): a party line built on Follow. Every client derives the same line from the relayed `/conga` and
// `/stop` chat lines (server time `at`) and the room state; nothing new goes on the wire.
import { CONGA_CAP, CONGA_WINDOW_MS, type MemberId, type ServerMessage } from "@omega/shared";
import type { ViewState } from "../state";

export interface Conga {
  /** Leader first. */
  readonly ids: readonly MemberId[];
  /** Server time of the last join. */
  readonly last: number;
}

export const NO_CONGA: Conga = { ids: [], last: Number.NEGATIVE_INFINITY };

/** A chat line `/conga …` joins the line, `/stop` leaves it; anything else is chat. */
export function congaText(text: string): "conga" | "stop" | null {
  if (/^\s*\/conga(?:\s|$)/i.test(text)) return "conga";
  return /^\s*\/stop\s*$/i.test(text) ? "stop" : null;
}

/** `id` sent `/conga` at `at`: the back of the line (a member keeps their place), a new line when the last join is over 2 min old, "full" past the cap. */
export function congaJoin(line: Conga, id: MemberId, at: number): Conga | "full" {
  if (at - line.last > CONGA_WINDOW_MS) return { ids: [id], last: at };
  if (line.ids.includes(id)) return { ids: line.ids, last: at };
  return line.ids.length >= CONGA_CAP ? "full" : { ids: [...line.ids, id], last: at };
}

/** `id` left the line; the one behind them now follows the one before them. */
export function congaLeave(line: Conga, id: MemberId): Conga {
  return line.ids.includes(id) ? { ids: line.ids.filter((m) => m !== id), last: line.last } : line;
}

/** Takes out whoever left the room or sat down (on a seat or the floor); the same line when nobody did. */
export function congaPrune(line: Conga, s: ViewState): Conga {
  const room = s.room;
  if (line.ids.length === 0) return line;
  const stays = (id: MemberId): boolean => room !== null && !room.seats.includes(id) && room.members.some((m) => m.id === id && m.floorSit !== true);
  return line.ids.every(stays) ? line : { ids: line.ids.filter(stays), last: line.last };
}

/** Who `id` follows: the one before them; null for the leader or anyone not in the line. */
export function congaAhead(line: Conga, id: MemberId | null): MemberId | null {
  const i = id === null ? -1 : line.ids.indexOf(id);
  return i > 0 ? (line.ids[i - 1] ?? null) : null;
}

/** The line after a server message: a snapshot's own (OME-1573), a relayed `/conga` or `/stop`; anything else keeps it. */
export function congaServer(line: Conga, _msg: ServerMessage): Conga {
  return line;
}
