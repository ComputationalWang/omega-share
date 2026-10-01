import * as v from "valibot";
import { FLOOR_CELLS, MAX_FURNITURE, SEAT_COUNT } from "./constants";

/**
 * Room layout v1 (ADR 0021): the furniture in a room, as data in the snapshot. The catalogue below restates the
 * art manifests (`assets/room/room.json`, set (g) `assets/furniture/furniture.json`), so the server validates a
 * layout without the asset files; a contract test pins the two together.
 */

export const FACINGS = ["ne", "nw", "se", "sw"] as const;
/** The way a piece faces, i.e. where a sitter looks. ne/nw face the TV corner, se/sw face the camera. */
export const FacingSchema = v.picklist(FACINGS);
export type Facing = v.InferOutput<typeof FacingSchema>;

export interface FurnitureSpec {
  /** `floor`: drawn with the floor, walkable, may lie under objects. `object`: solid, depth-sorted. `wall`: hangs on a wall. */
  readonly layer: "floor" | "object" | "wall";
  readonly facings: readonly Facing[];
  /** Footprint when facing ne or sw; nw and se swap it. Wall pieces take no floor cells (0×0). */
  readonly cols: number;
  readonly rows: number;
  /** Every footprint cell is a seat facing the piece's way. */
  readonly seats: boolean;
  /** Colour or artwork variants; variant 0 is the default. */
  readonly variants: number;
  /** Backs onto a wall: facing sw it stands on row 0 (right wall), facing se on col 0 (left wall). */
  readonly wallBacked: boolean;
}

const ONE = { cols: 1, rows: 1 } as const;
const piece = (layer: FurnitureSpec["layer"], facings: readonly Facing[], size: { readonly cols: number; readonly rows: number }, more: Partial<FurnitureSpec> = {}): FurnitureSpec => ({
  layer,
  facings,
  ...size,
  seats: false,
  variants: 1,
  wallBacked: false,
  ...more,
});
const CAMERA: readonly Facing[] = ["se", "sw"];
/** One sprite, so one canonical facing. */
const FIXED: readonly Facing[] = ["se"];

/**
 * Every piece a layout may hold. The room atlas gives `armchair`, `tv`, `lamp`, `plant` and the 7×7 `rug`;
 * set (g) gives the rest. Set (g)'s kilim runner is atlas id `rug`, so here it is `runner`.
 */
export const FURNITURE = {
  armchair: piece("object", FACINGS, ONE, { seats: true }),
  tv: piece("object", FIXED, ONE),
  lamp: piece("object", FIXED, ONE),
  plant: piece("object", FIXED, ONE),
  rug: piece("floor", FIXED, { cols: 7, rows: 7 }),
  sofa: piece("object", FACINGS, { cols: 2, rows: 1 }, { seats: true, variants: 2 }),
  couch: piece("object", FACINGS, { cols: 2, rows: 1 }, { seats: true, variants: 2 }),
  wingback: piece("object", FACINGS, ONE, { seats: true }),
  beanbag: piece("object", FACINGS, ONE, { seats: true, variants: 2 }),
  sidetable: piece("object", CAMERA, ONE),
  arclamp: piece("object", CAMERA, ONE),
  monstera: piece("object", CAMERA, ONE, { variants: 2 }),
  popcorn: piece("object", CAMERA, ONE),
  bookshelf: piece("object", CAMERA, { cols: 2, rows: 1 }, { wallBacked: true }),
  runner: piece("floor", ["ne", "nw"], { cols: 3, rows: 2 }, { variants: 2 }),
  frame: piece("wall", CAMERA, { cols: 0, rows: 0 }, { variants: 2 }),
} as const satisfies Record<string, FurnitureSpec>;

export type FurnitureKind = keyof typeof FURNITURE;
export const FURNITURE_KINDS = Object.keys(FURNITURE) as [FurnitureKind, ...FurnitureKind[]];
export const FurnitureKindSchema = v.picklist(FURNITURE_KINDS);

/** Wall segments with a window, poster or sconce (the same on both walls); frames need a plain one. */
export const WALL_FIXTURE_SEGMENTS: readonly number[] = [5, 6, 8];

const CellSchema = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(FLOOR_CELLS - 1));

interface Placed {
  readonly kind: FurnitureKind;
  readonly col: number;
  readonly row: number;
  readonly facing: Facing;
}

const turned = (f: Placed): boolean => f.facing === "nw" || f.facing === "se";

/** Floor cells `[col, row]` a piece covers, from its anchor cell toward +col and +row, cols before rows. */
export function footprintCells(f: Placed): [number, number][] {
  const spec: FurnitureSpec = FURNITURE[f.kind];
  const cols = turned(f) ? spec.rows : spec.cols;
  const rows = turned(f) ? spec.cols : spec.rows;
  const cells: [number, number][] = [];
  for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) cells.push([f.col + c, f.row + r]);
  return cells;
}

/** Wall pieces hang on the right wall at (col, 0) facing sw, on the left wall at (0, row) facing se. */
function wallSegment(f: Placed): string {
  return f.facing === "sw" ? `r${String(f.col)}` : `l${String(f.row)}`;
}

function onItsWall(f: Placed): boolean {
  const spec: FurnitureSpec = FURNITURE[f.kind];
  if (spec.layer !== "wall" && !spec.wallBacked) return true;
  if (f.facing === "sw" ? f.row !== 0 : f.col !== 0) return false;
  return spec.layer !== "wall" || !WALL_FIXTURE_SEGMENTS.includes(f.facing === "sw" ? f.col : f.row);
}

export const FurnitureSchema = v.pipe(
  v.object({
    kind: FurnitureKindSchema,
    col: CellSchema,
    row: CellSchema,
    facing: FacingSchema,
    /** Absent means 0. */
    variant: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  }),
  v.check((f) => FURNITURE[f.kind].facings.includes(f.facing), "facing the piece does not have"),
  v.check((f) => (f.variant ?? 0) < FURNITURE[f.kind].variants, "variant the piece does not have"),
  v.check((f) => footprintCells(f).every(([c, r]) => c < FLOOR_CELLS && r < FLOOR_CELLS), "piece off the floor"),
  v.check((f) => onItsWall(f), "piece off its wall"),
);
export type Furniture = v.InferOutput<typeof FurnitureSchema>;

export interface Seat {
  readonly col: number;
  readonly row: number;
  readonly facing: Facing;
}

/** Seat `i` is the `i`-th seat cell across seat-giving pieces, in `furniture` order (ADR 0021). */
export function layoutSeats(layout: { readonly furniture: readonly Placed[] }): Seat[] {
  const seats: Seat[] = [];
  for (const f of layout.furniture) {
    if (FURNITURE[f.kind].seats) for (const [col, row] of footprintCells(f)) seats.push({ col, row, facing: f.facing });
  }
  return seats;
}

/** True if no two pieces of `layer` share a cell (wall pieces: a wall segment). */
function disjoint(furniture: readonly Placed[], layer: FurnitureSpec["layer"]): boolean {
  const used = new Set<string>();
  for (const f of furniture) {
    if (FURNITURE[f.kind].layer !== layer) continue;
    const keys = layer === "wall" ? [wallSegment(f)] : footprintCells(f).map(([c, r]) => `${String(c)},${String(r)}`);
    for (const k of keys) {
      if (used.has(k)) return false;
      used.add(k);
    }
  }
  return true;
}

export const RoomLayoutSchema = v.pipe(
  v.object({
    furniture: v.pipe(v.array(FurnitureSchema), v.maxLength(MAX_FURNITURE)),
  }),
  v.check((l) => l.furniture.filter((f) => f.kind === "tv").length === 1, "exactly one tv"),
  v.check((l) => layoutSeats(l).length === SEAT_COUNT, "seat cells must total SEAT_COUNT"),
  v.check((l) => disjoint(l.furniture, "object"), "solid pieces overlap"),
  v.check((l) => disjoint(l.furniture, "floor"), "rugs overlap"),
  v.check((l) => disjoint(l.furniture, "wall"), "wall pieces share a segment"),
);
export type RoomLayout = v.InferOutput<typeof RoomLayoutSchema>;

/** Two rows of four armchairs facing the TV, split by an aisle (the pre-M4 `SEAT_CELLS`). */
const DEFAULT_SEAT_CELLS = [
  [1, 5], [2, 4], [4, 2], [5, 1],
  [3, 7], [4, 6], [6, 4], [7, 3],
] as const;

/** Today's room as data: what the server seeds and what a client without a `layout` draws. */
export const DEFAULT_LAYOUT: RoomLayout = {
  furniture: [
    { kind: "tv", col: 0, row: 0, facing: "se" },
    { kind: "rug", col: 1, row: 1, facing: "se" },
    ...DEFAULT_SEAT_CELLS.map(([col, row]): Furniture => ({ kind: "armchair", col, row, facing: col < row ? "ne" : "nw" })),
    { kind: "lamp", col: 9, row: 0, facing: "se" },
    { kind: "plant", col: 0, row: 9, facing: "se" },
  ],
};
