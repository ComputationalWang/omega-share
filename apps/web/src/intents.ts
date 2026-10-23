import * as v from "valibot";
import { ChatTextSchema, DEFAULT_LAYOUT, FLOOR_CELLS, MAX_POSITION_S, SEAT_COUNT, WALK_REFILL_MS, isStandable, type ClientMessage, type FloorCell, type Embed, type Member, type MemberId, type PlaybackState, type QueueItemId } from "@omega/shared";
import type { ViewState } from "./state";
import { expectedPosition } from "./sync";
import { lieStyleOf } from "./walk/lie";
import { TILE_MS } from "./walk/walks";
import { cellOf as cellIndex, colOf, rowOf, walkGrid, walkOverCell } from "./walk/path";

export interface SeatView {
  readonly index: number;
  readonly member: Member | null;
  readonly isSelf: boolean;
}

export function seatViews(state: Pick<ViewState, "room" | "self">): SeatView[] {
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

/** A lie key (OME-1691): lie down on layout piece `piece`, or get up from it if I lie there; null if nobody can lie on it or someone else does. */
export function lieIntent(state: Pick<ViewState, "status" | "room" | "self">, piece: number): ClientMessage | null {
  const room = state.room;
  if (state.status !== "open" || room === null || !Number.isInteger(piece)) return null;
  if (lieStyleOf(room.layout ?? DEFAULT_LAYOUT, piece) === undefined) return null;
  const lier = room.members.find((m) => m.lying === piece);
  if (lier === undefined) return { type: "lie", piece };
  return lier.id === state.self ? { type: "lie", piece: null } : null;
}

/** `/sit`, "Sit here" or S (OME-1501): sit on the floor of my cell, or get up; "no-cell" on a seat or a standing spot. */
export function floorSitIntent(state: ViewState): ClientMessage | "no-cell" | null {
  if (state.status !== "open" || state.room === null) return null;
  const me = state.room.members.find((m) => m.id === state.self);
  if (me?.cell === undefined) return "no-cell";
  return { type: "floor-sit", on: me.floorSit !== true };
}

/**
 * Clicking or tapping a floor cell (ADR 0053): walk to free floor, "blocked" under a solid piece (seats too: they sit),
 * nothing for my own cell. `run` jogs (OME-1464), even to my own cell: a double-click's first click already walks there.
 */
export function walkIntent(state: ViewState, cell: FloorCell, run = false): ClientMessage | "blocked" | null {
  const room = state.room;
  if (state.status !== "open" || room === null) return null;
  if (!isStandable(room.layout ?? DEFAULT_LAYOUT, cell)) return "blocked";
  const here = room.members.find((m) => m.id === state.self)?.cell;
  if (run) return { type: "walk", cell: { x: cell.x, y: cell.y }, run };
  if (here?.x === cell.x && here.y === cell.y) return null;
  return { type: "walk", cell: { x: cell.x, y: cell.y } };
}

/** Walk over (OME-1376): `walk` to the free cell beside `target` nearest me; null if there's none. */
/** `cellOf`: where the stage draws someone (a sitter's seat); a standing member's own cell comes first. */
export function walkOverIntent(state: ViewState, target: MemberId, cellOf: (id: MemberId) => FloorCell | null): ClientMessage | null {
  const room = state.room;
  if (state.status !== "open" || room === null || state.self === null) return null;
  const where = (id: MemberId): FloorCell | null => room.members.find((m) => m.id === id)?.cell ?? cellOf(id);
  const here = where(state.self);
  const there = where(target);
  if (here === null || there === null) return null;
  const taken = new Set<number>();
  for (const m of room.members) if (m.cell !== undefined && m.id !== state.self && m.id !== target) taken.add(cellIndex(m.cell.x, m.cell.y));
  const c = walkOverCell(walkGrid(room.layout ?? DEFAULT_LAYOUT), cellIndex(here.x, here.y), cellIndex(there.x, there.y), taken);
  if (c < 0 || c === cellIndex(here.x, here.y)) return null;
  return { type: "walk", cell: { x: colOf(c), y: rowOf(c) } };
}

export type StepKey = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown";

export const isStepKey = (k: string): k is StepKey => k === "ArrowLeft" || k === "ArrowRight" || k === "ArrowUp" || k === "ArrowDown";

/** The cell an arrow key steps to, as the editor's cursor does: Right/Left walk the column, Down/Up the row; null off the floor. */
export function stepCell(from: FloorCell, key: StepKey): FloorCell | null {
  const x = from.x + (key === "ArrowRight" ? 1 : key === "ArrowLeft" ? -1 : 0);
  const y = from.y + (key === "ArrowDown" ? 1 : key === "ArrowUp" ? -1 : 0);
  return x >= 0 && x < FLOOR_CELLS && y >= 0 && y < FLOOR_CELLS ? { x, y } : null;
}

/** A held arrow key steps at most once a tile, the walk (or with `run`, the jog) rate; a fresh press always steps. */
export function stepAllowed(repeat: boolean, now: number, last: number, run = false): boolean {
  return !repeat || now - last >= (run ? TILE_MS / 2 : TILE_MS);
}

export function chatIntent(raw: string): ClientMessage | null {
  const r = v.safeParse(ChatTextSchema, raw);
  return r.success ? { type: "chat", text: r.output } : null;
}

/** What the shared transport acts on: the room's embed and playback (RoomState fits). */
export interface PlaybackTarget {
  readonly embed: Embed | null;
  readonly playback?: PlaybackState | null | undefined;
  /** The current queue item's id (ADR 0031), for `ended`; absent from a pre-M6 server. */
  readonly itemId?: QueueItemId | undefined;
}

type Control = Extract<ClientMessage, { type: "control" }>;

function control(t: PlaybackTarget, playing: boolean, position: number): Control | null {
  if (t.embed === null || Number.isNaN(position)) return null;
  return { type: "control", url: t.embed.url, playing, position: Math.min(MAX_POSITION_S, Math.max(0, position)) };
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

export interface WalkGate {
  push(msg: ClientMessage): void;
  cancel(): void;
}

/**
 * Free-walk clicks at the walk rate (OME-1371): at most one `walk` per WALK_REFILL_MS, the latest target sent last.
 * A click flood then stays under the server's walk bucket and its per-socket frame limit, and the final click wins.
 */
export function createWalkGate(deps: { now: () => number; send: (m: ClientMessage) => void; setTimer: (fn: () => void, ms: number) => void }): WalkGate {
  let last = -Infinity;
  let pending: ClientMessage | null = null;
  const flush = (): void => {
    if (pending === null) return;
    const m = pending;
    pending = null;
    last = deps.now();
    deps.send(m);
  };
  return {
    push(msg) {
      const wait = last + WALK_REFILL_MS - deps.now();
      const armed = pending !== null;
      pending = msg;
      if (wait <= 0) flush();
      else if (!armed) deps.setTimer(flush, wait);
    },
    // A seat click outranks any walk still held; a timer already armed then flushes nothing.
    cancel() {
      pending = null;
    },
  };
}

/** OME-1464: two clicks or taps on one cell within this many ms jog there. */
export const DOUBLE_TAP_MS = 500;

/** True if a click on `cell` at `at` makes a double with the one before it (`prev`). */
export function doubleTap(prev: { readonly cell: FloorCell; readonly at: number } | null, cell: FloorCell, at: number): boolean {
  return prev !== null && prev.cell.x === cell.x && prev.cell.y === cell.y && at - prev.at <= DOUBLE_TAP_MS;
}
