// Stage px ↔ the owner editor's targets: which floor cell or wall slot a click lands on, and which set (h) footprint markers
// (assets/README.md "Set (h)") ring a piece. Pure, part of the lazy editor chunk.
import { FLOOR_CELLS, FURNITURE, footprintCells, type Facing, type Furniture } from "@omega/shared";
import { STAGE_W, TILE_H, TILE_W, cellCenter } from "../layout";

/** A floor cell, or with `wall` set the wall slot a print hangs in (its anchor cell and facing, layout.ts in @omega/shared). */
export interface Slot {
  readonly col: number;
  readonly row: number;
  readonly wall: Extract<Facing, "se" | "sw"> | null;
}

/** The floor's back corner (cell (0,0)'s top vertex), as in layout.ts. */
const BACK = { x: STAGE_W / 2, y: cellCenter(0, 0).y - TILE_H / 2 };
/** How far above the floor's back edges a click still counts as on the wall. */
const WALL_H = 160;

const onFloor = (n: number): boolean => n >= 0 && n < FLOOR_CELLS;

export function slotAt(x: number, y: number): Slot | null {
  const u = (x - BACK.x) / (TILE_W / 2);
  const v = (y - BACK.y) / (TILE_H / 2) - 1;
  const col = Math.round((u + v) / 2);
  const row = Math.round((v - u) / 2);
  if (onFloor(col) && onFloor(row)) return { col, row, wall: null };
  const right = x >= BACK.x;
  const along = Math.abs(x - BACK.x);
  const above = BACK.y + along / 2 - y;
  if (above <= 0 || above > WALL_H) return null;
  const i = Math.floor(along / (TILE_W / 2));
  if (!onFloor(i)) return null;
  return right ? { col: i, row: 0, wall: "sw" } : { col: 0, row: i, wall: "se" };
}

export type MarkerState = "ok" | "no" | "sel";

export interface Marker {
  readonly key: string;
  readonly col: number;
  readonly row: number;
}

/** Footprints the kit has a ring for; others (the 7×7 rug) get a 1×1 ring per cell. */
const RINGS: ReadonlySet<string> = new Set(["1x1", "2x1", "1x2", "3x2", "2x3"]);

export function markerKeys(f: Pick<Furniture, "kind" | "col" | "row" | "facing">, state: MarkerState): Marker[] {
  const spec = FURNITURE[f.kind];
  // The kit has no selected wall ring; a picked print shows its ok ring.
  if (spec.layer === "wall") return [{ key: `place/${state === "no" ? "no" : "ok"}/wall-${f.facing}`, col: f.col, row: f.row }];
  const turned = f.facing === "nw" || f.facing === "se";
  const size = `${String(turned ? spec.rows : spec.cols)}x${String(turned ? spec.cols : spec.rows)}`;
  if (RINGS.has(size)) return [{ key: `place/${state}/${size}`, col: f.col, row: f.row }];
  return footprintCells(f).map(([col, row]) => ({ key: `place/${state}/1x1`, col, row }));
}
