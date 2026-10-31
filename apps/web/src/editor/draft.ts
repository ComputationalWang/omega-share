import {
  FURNITURE,
  FURNITURE_KINDS,
  FurnitureSchema,
  MAX_FURNITURE,
  RoomIdSchema,
  RoomLayoutSchema,
  SEAT_COUNT,
  footprintCells,
  isScreen,
  layoutSeats,
  type Facing,
  type Furniture,
  type FurnitureKind,
  type RoomId,
  type RoomLayout,
} from "@omega/shared";
import * as v from "valibot";
import { layoutKey } from "../furniture";
import { roomIdInPath } from "../route";

export { layoutKey };

/** The owner layout editor's draft model: pure functions over a layout, each returning a new one (or null if the edit would be illegal). */

export type Layout = RoomLayout;

const cellKey = (c: number, r: number): string => `${String(c)},${String(r)}`;

/** Wall pieces hang on the right wall at (col, 0) facing sw, on the left wall at (0, row) facing se. */
const wallKey = (f: Furniture): string => (f.facing === "sw" ? `r${String(f.col)}` : `l${String(f.row)}`);

/** The keys a piece occupies within its own layer: floor cells, or a wall segment. */
function claims(f: Furniture): string[] {
  return FURNITURE[f.kind].layer === "wall" ? [wallKey(f)] : footprintCells(f).map(([c, r]) => cellKey(c, r));
}

/** The piece alone is legal and doesn't collide with a same-layer piece (ignoring index `skip`). */
export function fits(layout: Layout, piece: Furniture, skip?: number): boolean {
  if (!v.safeParse(FurnitureSchema, piece).success) return false;
  const layer = FURNITURE[piece.kind].layer;
  const mine = new Set(claims(piece));
  return layout.furniture.every((other, i) => {
    if (i === skip || FURNITURE[other.kind].layer !== layer) return true;
    return claims(other).every((k) => !mine.has(k));
  });
}

export function place(layout: Layout, piece: Furniture): Layout | null {
  if (layout.furniture.length >= MAX_FURNITURE || !fits(layout, piece) || (piece.kind === "pad" && padCount(layout) >= 2)) return null;
  return { ...layout, furniture: [...layout.furniture, piece] };
}

function replaceAt(layout: Layout, index: number, piece: Furniture): Layout | null {
  if (!fits(layout, piece, index)) return null;
  return { ...layout, furniture: layout.furniture.map((f, i) => (i === index ? piece : f)) };
}

export function move(layout: Layout, index: number, col: number, row: number): Layout | null {
  const f = layout.furniture[index];
  return f ? replaceAt(layout, index, { ...f, col, row }) : null;
}

/** Next facing, in the catalogue's order and cyclically, that fits at the same anchor. */
export function rotate(layout: Layout, index: number): Layout | null {
  const f = layout.furniture[index];
  if (!f) return null;
  const facings = FURNITURE[f.kind].facings;
  const at = facings.indexOf(f.facing);
  for (let step = 1; step < facings.length; step++) {
    const facing = facings[(at + step) % facings.length];
    if (!facing) continue;
    const turned = replaceAt(layout, index, { ...f, facing });
    if (turned) return turned;
  }
  return null;
}

/** Removing a pad removes its pair too (OME-1548): a layout holds 0 or 2. */
export function remove(layout: Layout, index: number): Layout {
  const pad = layout.furniture[index]?.kind === "pad";
  return { ...layout, furniture: layout.furniture.filter((f, i) => i !== index && !(pad && f.kind === "pad")) };
}

/** Index of the piece under a floor cell: objects first, then floor pieces, then a wall piece anchored there. Later pieces win. */
export function pieceAt(layout: Layout, col: number, row: number): number | null {
  const last = (match: (f: Furniture) => boolean): number | null => {
    for (let i = layout.furniture.length - 1; i >= 0; i--) {
      const f = layout.furniture[i];
      if (f && match(f)) return i;
    }
    return null;
  };
  const covers = (f: Furniture): boolean => footprintCells(f).some(([c, r]) => c === col && r === row);
  return (
    last((f) => FURNITURE[f.kind].layer === "object" && covers(f)) ??
    last((f) => FURNITURE[f.kind].layer === "floor" && covers(f)) ??
    last((f) => FURNITURE[f.kind].layer === "wall" && f.col === col && f.row === row)
  );
}

/** How many teleport pads (OME-1548) the draft has: a saved layout holds 0 or 2. */
export const padCount = (layout: Layout): number => layout.furniture.filter((f) => f.kind === "pad").length;
/** One pad is down and its pair is still to place. */
export const needsSecondPad = (layout: Layout): boolean => padCount(layout) === 1;

export function defaultFacing(kind: FurnitureKind, col: number, row: number): Facing {
  const spec = FURNITURE[kind];
  const first: Facing = spec.facings[0] ?? "se";
  if (spec.layer !== "wall" && !spec.wallBacked) return first;
  if (row === 0 && spec.facings.includes("sw")) return "sw";
  if (col === 0 && spec.facings.includes("se")) return "se";
  return first;
}

export type Problem =
  | { readonly code: "seats"; readonly have: number; readonly need: number }
  | { readonly code: "tv"; readonly have: number }
  | { readonly code: "overlap" }
  | { readonly code: "pad" }
  | { readonly code: "too-many"; readonly have: number; readonly max: number }
  | { readonly code: "invalid" };

function overlaps(furniture: readonly Furniture[]): boolean {
  const used = new Set<string>();
  for (const f of furniture) {
    const layer = FURNITURE[f.kind].layer;
    for (const k of claims(f)) {
      const key = `${layer}:${k}`;
      if (used.has(key)) return true;
      used.add(key);
    }
  }
  return false;
}

/** Empty exactly when `RoomLayoutSchema` accepts the layout. */
export function problems(layout: Layout): Problem[] {
  if (v.safeParse(RoomLayoutSchema, layout).success) return [];
  const out: Problem[] = [];
  const f = layout.furniture;
  if (f.length > MAX_FURNITURE) out.push({ code: "too-many", have: f.length, max: MAX_FURNITURE });
  const tvs = f.filter((p) => isScreen(p.kind)).length;
  if (tvs !== 1) out.push({ code: "tv", have: tvs });
  const seats = layoutSeats(layout).length;
  if (seats !== SEAT_COUNT) out.push({ code: "seats", have: seats, need: SEAT_COUNT });
  if (overlaps(f)) out.push({ code: "overlap" });
  if (needsSecondPad(layout)) out.push({ code: "pad" });
  if (out.length === 0 || f.some((p) => !v.safeParse(FurnitureSchema, p).success)) out.push({ code: "invalid" });
  return out;
}

const plural = (n: number, word: string): string => `${String(n)} ${word}${n === 1 ? "" : "s"}`;

export function problemText(p: Problem): string {
  switch (p.code) {
    case "seats":
      return p.have < p.need
        ? `${String(p.have)} of ${String(p.need)} seats: add ${plural(p.need - p.have, "more seat")}`
        : `${String(p.have)} of ${String(p.need)} seats: remove ${plural(p.have - p.need, "seat")}`;
    case "tv":
      return "The room needs exactly one TV";
    case "overlap":
      return "Some pieces overlap";
    case "pad":
      return "Place the second teleport pad";
    case "too-many":
      return `Too many pieces (${String(p.have)} of ${String(p.max)})`;
    case "invalid":
      return "A piece is not allowed where it is";
  }
}

export interface TrayTab {
  readonly id: "seats" | "decor" | "floor";
  readonly label: "Seats" | "Decor" | "Floor & wall";
  readonly kinds: readonly FurnitureKind[];
}

// shortcut: the Dank Dungeon v6 kinds but the queen bed (OME-1984) are not in the tray yet; the preset places them, the owner can't add more. Wire the tray when asked.
export const AWAITING_ART: ReadonlySet<FurnitureKind> = new Set(["whirlpool", "mirror", "minibar", "desk", "washbasin", "partition", "wallscreen", "projector"]);
const kindsWhere = (pick: (k: FurnitureKind) => boolean): readonly FurnitureKind[] => FURNITURE_KINDS.filter((k) => !AWAITING_ART.has(k) && pick(k));

/** What the owner typed or pasted as a door's room (OME-1425): a room link of this site, or a bare room id. */
export function parseDoorTarget(text: string, origin: string, current: RoomId): { readonly ok: true; readonly id: RoomId } | { readonly ok: false; readonly error: string } {
  const t = text.trim();
  const bare = v.safeParse(RoomIdSchema, t);
  let id: RoomId | null = bare.success ? bare.output : null;
  if (id === null) {
    try {
      const url = new URL(t, origin);
      if (url.origin === origin) id = roomIdInPath(url.pathname);
    } catch {
      id = null;
    }
  }
  if (id === null) return { ok: false, error: "That is not a room link of this site. Paste a link like /r/<room>." };
  if (id === current) return { ok: false, error: "A door can't lead to its own room." };
  return { ok: true, id };
}

/** The most doors a room has (ADR 0054) and how many a draft has. */
export const doorCount = (layout: Layout): number => layout.furniture.filter((f) => f.kind === "door").length;
const isSeat = (k: FurnitureKind): boolean => FURNITURE[k].seats;
const isFlat = (k: FurnitureKind): boolean => FURNITURE[k].layer !== "object";

export const TRAY_TABS: readonly TrayTab[] = [
  { id: "seats", label: "Seats", kinds: kindsWhere(isSeat) },
  { id: "decor", label: "Decor", kinds: kindsWhere((k) => !isSeat(k) && !isFlat(k)) },
  { id: "floor", label: "Floor & wall", kinds: kindsWhere((k) => !isSeat(k) && isFlat(k)) },
];

/** Same content, by `layoutKey`, and the same mood (absent is none; not in the key, which only the furniture's scene uses). */
export const sameLayout = (a: Layout, b: Layout): boolean => a === b || (layoutKey(a) === layoutKey(b) && (a.mood ?? "none") === (b.mood ?? "none"));

/**
 * The room's saved layout became `next` while the owner edits `draft` (`saving`: we sent a `layout-set` not yet answered).
 * By content, since a re-join snapshot parses an equal but new layout. `same`: nothing changed, keep the draft (and the
 * selection). `saved`: our save came back. `replaced`: an untouched draft follows a save from elsewhere (another tab).
 * `conflict`: someone else saved while ours is unsaved; we keep ours, and Save replaces theirs.
 */
export function reconcile(r: { readonly saved: Layout; readonly draft: Layout; readonly next: Layout; readonly saving: boolean }): {
  readonly draft: Layout;
  readonly outcome: "same" | "saved" | "replaced" | "conflict";
} {
  if (sameLayout(r.next, r.saved)) return { draft: r.draft, outcome: "same" };
  if (sameLayout(r.next, r.draft)) return { draft: r.next, outcome: r.saving ? "saved" : "replaced" };
  if (sameLayout(r.draft, r.saved)) return { draft: r.next, outcome: "replaced" };
  return { draft: r.draft, outcome: "conflict" };
}
