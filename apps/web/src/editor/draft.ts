import {
  FURNITURE,
  FURNITURE_KINDS,
  FurnitureSchema,
  MAX_FURNITURE,
  RoomLayoutSchema,
  SEAT_COUNT,
  footprintCells,
  layoutSeats,
  type Facing,
  type Furniture,
  type FurnitureKind,
  type RoomLayout,
} from "@omega/shared";
import * as v from "valibot";

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
  if (layout.furniture.length >= MAX_FURNITURE || !fits(layout, piece)) return null;
  return { furniture: [...layout.furniture, piece] };
}

function replaceAt(layout: Layout, index: number, piece: Furniture): Layout | null {
  if (!fits(layout, piece, index)) return null;
  return { furniture: layout.furniture.map((f, i) => (i === index ? piece : f)) };
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

export function remove(layout: Layout, index: number): Layout {
  return { furniture: layout.furniture.filter((_, i) => i !== index) };
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
  const tvs = f.filter((p) => p.kind === "tv").length;
  if (tvs !== 1) out.push({ code: "tv", have: tvs });
  const seats = layoutSeats(layout).length;
  if (seats !== SEAT_COUNT) out.push({ code: "seats", have: seats, need: SEAT_COUNT });
  if (overlaps(f)) out.push({ code: "overlap" });
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

const kindsWhere = (pick: (k: FurnitureKind) => boolean): readonly FurnitureKind[] => FURNITURE_KINDS.filter(pick);
const isSeat = (k: FurnitureKind): boolean => FURNITURE[k].seats;
const isFlat = (k: FurnitureKind): boolean => FURNITURE[k].layer !== "object";

export const TRAY_TABS: readonly TrayTab[] = [
  { id: "seats", label: "Seats", kinds: kindsWhere(isSeat) },
  { id: "decor", label: "Decor", kinds: kindsWhere((k) => !isSeat(k) && !isFlat(k)) },
  { id: "floor", label: "Floor & wall", kinds: kindsWhere((k) => !isSeat(k) && isFlat(k)) },
];
