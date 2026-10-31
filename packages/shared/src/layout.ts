import * as v from "valibot";
import { FLOOR_CELLS, MAX_DOORS, MAX_FURNITURE, SEAT_COUNT } from "./constants";
import { RoomIdSchema, type RoomId } from "./ids";

/**
 * Room layout v1 (ADR 0021): the furniture in a room, as data in the snapshot. The catalogue below restates the
 * art manifests (`assets/room/room.json`, set (g) `assets/furniture/furniture.json`), so the server validates a
 * layout without the asset files; a contract test pins the two together.
 */

export const FACINGS = ["ne", "nw", "se", "sw"] as const;
/** The way a piece faces, i.e. where a sitter looks. ne/nw face the TV corner, se/sw face the camera. */
export const FacingSchema = v.picklist(FACINGS);
export type Facing = v.InferOutput<typeof FacingSchema>;

/**
 * How a member lies on a piece (OME-1773): stretched out (`lie`) or curled up (`curl`), one lier per piece; or asleep
 * (`sleep`, OME-2008), up to the piece's seat count side by side. Art in `assets/avatars/lying.json`.
 */
export const LIE_STYLES = ["lie", "curl", "sleep"] as const;
export type LieStyle = (typeof LIE_STYLES)[number];

export interface FurnitureSpec {
  /** `floor`: drawn with the floor, walkable, may lie under objects. `object`: solid, depth-sorted. `wall`: hangs on a wall. */
  readonly layer: "floor" | "object" | "wall";
  readonly facings: readonly Facing[];
  /** Footprint when facing ne or sw; nw and se swap it. Wall pieces take no floor cells (0×0). */
  readonly cols: number;
  readonly rows: number;
  /** Every footprint cell is a seat facing the piece's way. */
  readonly seats: boolean;
  /** Seats only the first `seatCells` cells of its seat row, from the anchor. Absent: the whole row. */
  readonly seatCells?: number;
  /** Colour or artwork variants; variant 0 is the default. */
  readonly variants: number;
  /** Backs onto a wall: facing sw it stands on row 0 (right wall), facing se on col 0 (left wall). */
  readonly wallBacked: boolean;
  /**
   * A member may lie on it (`lie` message). `lie`/`curl`: one lier, blocking all its seats. `sleep`: one sleeper per
   * seat, sleeper `i` blocking seat `i` of the piece (OME-2008). Absent: not a bed for anyone.
   */
  readonly lie?: LieStyle;
  /** Wall segments a wall piece covers, from its anchor toward +col (right wall) or +row (left wall) (ADR 0058). Absent: 1. */
  readonly wallSpan?: number;
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
 * set (g) gives the v1 rest, catalogue v2 (`assets/furniture/furniture-v2.json`, lazy) the next ones up to the door. Set (g)'s kilim runner is
 * atlas id `rug`, so here it is `runner`.
 */
// The sofa, beanbag, runner, pouf and stool variants 2–3 and the rug variants 1–2 are recolours (OME-1463, assets/furniture/recolours.json).
export const FURNITURE = {
  armchair: piece("object", FACINGS, ONE, { seats: true }),
  /** Variant 1 (OME-1989) keeps variant 0's screen rect and anchor: the player overlay does not know variants. */
  tv: piece("object", FIXED, ONE, { variants: 2 }),
  lamp: piece("object", FIXED, ONE, { variants: 3 }),
  plant: piece("object", FIXED, ONE, { variants: 3 }),
  rug: piece("floor", FIXED, { cols: 7, rows: 7 }, { variants: 3 }),
  sofa: piece("object", FACINGS, { cols: 2, rows: 1 }, { seats: true, variants: 4, lie: "lie" }),
  couch: piece("object", FACINGS, { cols: 2, rows: 1 }, { seats: true, variants: 2, lie: "lie" }),
  wingback: piece("object", FACINGS, ONE, { seats: true }),
  beanbag: piece("object", FACINGS, ONE, { seats: true, variants: 4 }),
  sidetable: piece("object", CAMERA, ONE),
  arclamp: piece("object", CAMERA, ONE, { variants: 3 }),
  monstera: piece("object", CAMERA, ONE, { variants: 4 }),
  popcorn: piece("object", CAMERA, ONE),
  bookshelf: piece("object", CAMERA, { cols: 2, rows: 1 }, { wallBacked: true, variants: 3 }),
  runner: piece("floor", ["ne", "nw"], { cols: 3, rows: 2 }, { variants: 4 }),
  frame: piece("wall", CAMERA, { cols: 0, rows: 0 }, { variants: 4 }),
  floorcushion: piece("object", FACINGS, ONE, { seats: true, variants: 2 }),
  bench: piece("object", FACINGS, { cols: 2, rows: 1 }, { seats: true, variants: 2 }),
  turntable: piece("object", CAMERA, ONE),
  speaker: piece("object", CAMERA, ONE, { variants: 2 }),
  /** Curl up beside it; it stays a non-seat, so seat indices don't move (OME-1773). */
  cat: piece("object", CAMERA, ONE, { variants: 2, lie: "curl" }),
  wallshelf: piece("wall", CAMERA, { cols: 0, rows: 0 }, { variants: 3 }),
  garland: piece("wall", CAMERA, { cols: 0, rows: 0 }, { variants: 4 }),
  coffeetable: piece("object", CAMERA, ONE),
  pouf: piece("object", FACINGS, ONE, { seats: true, variants: 4 }),
  neonsign: piece("wall", CAMERA, { cols: 0, rows: 0 }, { variants: 2 }),
  aquarium: piece("object", CAMERA, ONE),
  arcade: piece("object", CAMERA, ONE),
  wallclock: piece("wall", CAMERA, { cols: 0, rows: 0 }),
  /** Leads to the room in its `target` (ADR 0054). */
  door: piece("object", CAMERA, ONE, { variants: 2, wallBacked: true }),
  // Batch 6 (`assets/furniture/furniture-v4.json`, lazy). The counter and piano may back onto a wall but stand free too.
  hammock: piece("object", FACINGS, { cols: 2, rows: 1 }, { seats: true }),
  stool: piece("object", FACINGS, ONE, { seats: true, variants: 4 }),
  barcounter: piece("object", CAMERA, { cols: 2, rows: 1 }),
  piano: piece("object", CAMERA, { cols: 2, rows: 1 }, { variants: 2 }),
  fireplace: piece("object", CAMERA, ONE, { wallBacked: true }),
  /** A teleport pad (OME-1545): a layout holds 0 or exactly 2, and a `walk` with `teleport` goes from one to the other. */
  pad: piece("floor", FIXED, ONE, { variants: 2 }),
  // Theatre set (OME-1625 / OME-1639, `assets/furniture/furniture-v5.json`, lazy).
  /** Two flip seats on a riser; the variant is the riser step (0 floor, 1 one step, 2 two steps). */
  theatrerow: piece("object", ["ne", "nw"], { cols: 2, rows: 1 }, { seats: true, variants: 3 }),
  /** A stage curtain; the facing picks the wall (se left, sw right). */
  curtain: piece("wall", CAMERA, { cols: 0, rows: 0 }),
  /** The 2× screen frame: a layout's screen, instead of the `tv` (see `SCREEN_KINDS`). */
  bigscreen: piece("object", FIXED, ONE),
  aislelight: piece("floor", ["ne", "nw"], ONE),
  carpet: piece("floor", FIXED, { cols: 2, rows: 2 }, { variants: 2 }),
  // Dank Dungeon (OME-1670 / OME-1672, `assets/furniture/furniture-v6.json`, lazy).
  /** A queen bed (OME-1982): 2×2, two sleepers side by side on its front row (ADR 0057). */
  bed: piece("object", FACINGS, { cols: 2, rows: 2 }, { seats: true, lie: "sleep" }),
  whirlpool: piece("object", FACINGS, { cols: 2, rows: 1 }, { seats: true }),
  mirror: piece("wall", CAMERA, { cols: 0, rows: 0 }, { variants: 2 }),
  minibar: piece("object", CAMERA, ONE, { variants: 2 }),
  desk: piece("object", CAMERA, ONE),
  washbasin: piece("object", CAMERA, ONE, { wallBacked: true }),
  /** An interior wall cell (OME-1958): the facing picks its axis (like `curtain`); 0 and 2 solid, 1 and 3 glass (OME-1989). A doorway is a gap in the row. */
  partition: piece("object", CAMERA, ONE, { variants: 4 }),
  // Dank Dungeon v7 (OME-1989, `assets/furniture/furniture-v7.json`, lazy).
  sauna: piece("object", CAMERA, { cols: 2, rows: 2 }, { wallBacked: true }),
  /** Two bathers on its first row, drawn in front of them like the whirlpool. */
  soaktub: piece("object", FIXED, { cols: 2, rows: 2 }, { seats: true }),
  /** One seat at its anchor; lie on it full length. */
  lounger: piece("object", FACINGS, { cols: 2, rows: 1 }, { seats: true, seatCells: 1, lie: "lie" }),
  // Wall screens (OME-2065, ADR 0058): a layout's screen hung on a wall, instead of the `tv`.
  /** A flat panel over 2 wall segments. */
  wallscreen: piece("wall", CAMERA, { cols: 0, rows: 0 }, { wallSpan: 2 }),
  /** A pull-down screen over 3 wall segments. */
  projector: piece("wall", CAMERA, { cols: 0, rows: 0 }, { wallSpan: 3 }),
} as const satisfies Record<string, FurnitureSpec>;

export type FurnitureKind = keyof typeof FURNITURE;
export const FURNITURE_KINDS = Object.keys(FURNITURE) as [FurnitureKind, ...FurnitureKind[]];
export const FurnitureKindSchema = v.picklist(FURNITURE_KINDS);

/** The kinds that are a room's screen (ADR 0056): a layout holds exactly one of them. Treat them alike (glow, lights-down). */
export const SCREEN_KINDS = ["tv", "bigscreen", "wallscreen", "projector"] as const satisfies readonly FurnitureKind[];
const screenKinds: readonly FurnitureKind[] = SCREEN_KINDS;
export const isScreen = (kind: FurnitureKind): boolean => screenKinds.includes(kind);

/** Wall segments with a window, poster or sconce (the same on both walls); frames need a plain one. */
export const WALL_FIXTURE_SEGMENTS: readonly number[] = [5, 6, 8];

/** A piece's place in `layout.furniture` (OME-1773): an integer in `0..MAX_FURNITURE`. */
export const PieceIndexSchema = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(MAX_FURNITURE - 1));
export type PieceIndex = v.InferOutput<typeof PieceIndexSchema>;

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

/** The wall segments a wall piece covers: it hangs on the right wall at (col, 0) facing sw, on the left wall at (0, row) facing se, over `wallSpan` segments. */
function wallSegments(f: Placed): number[] {
  const first = f.facing === "sw" ? f.col : f.row;
  const spec: FurnitureSpec = FURNITURE[f.kind];
  return Array.from({ length: spec.wallSpan ?? 1 }, (_, i) => first + i);
}

function onItsWall(f: Placed): boolean {
  const spec: FurnitureSpec = FURNITURE[f.kind];
  if (spec.layer !== "wall" && !spec.wallBacked) return true;
  if (f.facing === "sw" ? f.row !== 0 : f.col !== 0) return false;
  return spec.layer !== "wall" || wallSegments(f).every((i) => i < FLOOR_CELLS && !WALL_FIXTURE_SEGMENTS.includes(i));
}

/** A wall piece over a window, poster or sconce of the default shell (OME-2085). Stub. */
export const onFixture = (_f: Placed): boolean => false;

const FURNITURE_ENTRIES = {
  kind: FurnitureKindSchema,
  col: CellSchema,
  row: CellSchema,
  facing: FacingSchema,
  /** Absent means 0. */
  variant: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  /** A door's room (ADR 0054): required on a door, refused on anything else. A room id, never a URL. */
  target: v.optional(RoomIdSchema),
};

/** One piece's rules on top of its fields; `base` decides whether unknown keys are stripped or refused. */
const furniture = (base: v.ObjectSchema<typeof FURNITURE_ENTRIES, undefined> | v.StrictObjectSchema<typeof FURNITURE_ENTRIES, undefined>) =>
  v.pipe(
    base,
    v.check((f) => FURNITURE[f.kind].facings.includes(f.facing), "facing the piece does not have"),
    v.check((f) => (f.variant ?? 0) < FURNITURE[f.kind].variants, "variant the piece does not have"),
    v.check((f) => footprintCells(f).every(([c, r]) => c < FLOOR_CELLS && r < FLOOR_CELLS), "piece off the floor"),
    v.check((f) => onItsWall(f), "piece off its wall"),
    v.check((f) => (f.kind === "door") === (f.target !== undefined), "a door needs a target, and only a door has one"),
  );

/** A placed piece, server → client: unknown keys are stripped. */
export const FurnitureSchema = furniture(v.object(FURNITURE_ENTRIES));
export type Furniture = v.InferOutput<typeof FurnitureSchema>;

export interface Seat {
  readonly col: number;
  readonly row: number;
  readonly facing: Facing;
}

/** A floor cell by its column (`x`) and row (`y`), 0..FLOOR_CELLS-1 (ADR 0053). */
const FLOOR_CELL_ENTRIES = { x: CellSchema, y: CellSchema };
/** Server → client (`walked`, a member's `cell`): unknown keys are stripped. */
export const FloorCellSchema = v.object(FLOOR_CELL_ENTRIES);
/** Client → server (`walk`): unknown keys are refused. */
export const FloorCellInputSchema = v.strictObject(FLOOR_CELL_ENTRIES);
export type FloorCell = v.InferOutput<typeof FloorCellSchema>;

/** Where people walk in, and where a layout change sends someone whose cell it covered: the floor's front corner. */
export const DOOR_CELL: FloorCell = { x: FLOOR_CELLS - 1, y: FLOOR_CELLS - 1 };

/** A cell someone may stand on (`walk`): no solid piece covers it. Seats are solid, so they need `sit`. */
export function isStandable(layout: { readonly furniture: readonly Placed[] }, cell: FloorCell): boolean {
  return !layout.furniture.some((f) => FURNITURE[f.kind].layer === "object" && footprintCells(f).some(([c, r]) => c === cell.x && r === cell.y));
}

/** A `walk` with `teleport` from `from` to `cell` (OME-1545): `from` is one pad's cell, `cell` the other's, and nothing solid covers it. */
export function canTeleport(layout: { readonly furniture: readonly Placed[] }, from: FloorCell | undefined, cell: FloorCell): boolean {
  const isPad = (c: FloorCell): boolean => layout.furniture.some((f) => f.kind === "pad" && f.col === c.x && f.row === c.y);
  return from !== undefined && (from.x !== cell.x || from.y !== cell.y) && isPad(from) && isPad(cell) && isStandable(layout, cell);
}

/**
 * Seat `i` is the `i`-th seat cell across seat-giving pieces, in `furniture` order (ADR 0021). A piece seats along its
 * first row only (ADR 0057): the anchor row. A `sleep` piece (the bed) seats along its front row, where the art lays
 * its sleepers: the anchor row for ne/nw, the last row for se/sw (OME-2008).
 */
export function layoutSeats(layout: { readonly furniture: readonly Placed[] }): Seat[] {
  const seats: Seat[] = [];
  for (const f of layout.furniture) {
    const spec: FurnitureSpec = FURNITURE[f.kind];
    if (!spec.seats) continue;
    const back = spec.lie === "sleep" && (f.facing === "se" || f.facing === "sw") ? spec.rows - 1 : 0;
    const row = footprintCells(f).filter(([c, r]) => (turned(f) ? c === f.col + back : r === f.row + back));
    for (const [col, r] of row.slice(0, spec.seatCells)) seats.push({ col, row: r, facing: f.facing });
  }
  return seats;
}

/** True if no two pieces of `layer` share a cell (wall pieces: a wall segment). */
function disjoint(furniture: readonly Placed[], layer: FurnitureSpec["layer"]): boolean {
  const used = new Set<string>();
  for (const f of furniture) {
    if (FURNITURE[f.kind].layer !== layer) continue;
    const keys = layer === "wall" ? wallSegments(f).map((i) => `${f.facing === "sw" ? "r" : "l"}${String(i)}`) : footprintCells(f).map(([c, r]) => `${String(c)},${String(r)}`);
    for (const k of keys) {
      if (used.has(k)) return false;
      used.add(k);
    }
  }
  return true;
}

/** A partition line (ADR 0058): sw partitions stand on one `row`, se ones on one `col`. */
export interface PartitionLine {
  readonly axis: "row" | "col";
  readonly at: number;
}

const lineOf = (f: Placed): PartitionLine => (f.facing === "sw" ? { axis: "row", at: f.row } : { axis: "col", at: f.col });

/** The layout's partition line, or undefined without partitions. A valid layout has at most one. */
export function partitionLine(layout: { readonly furniture: readonly Placed[] }): PartitionLine | undefined {
  const first = layout.furniture.find((f) => f.kind === "partition");
  return first === undefined ? undefined : lineOf(first);
}

function onePartitionLine(furniture: readonly Placed[]): boolean {
  const line = partitionLine({ furniture });
  return furniture.every((f) => {
    if (f.kind !== "partition") return true;
    const l = lineOf(f);
    return l.axis === line?.axis && l.at === line.at;
  });
}

/** The room's lighting mood (OME-1499), set by the owner with `layout-set`. Absent, as on every layout saved before it, means "none". */
export const ROOM_MOODS = ["none", "warm", "cool", "night"] as const;
export const RoomMoodSchema = v.picklist(ROOM_MOODS);
export type RoomMood = v.InferOutput<typeof RoomMoodSchema>;

/** The room's wall and floor skin (OME-1989, ADR 0058), set by a partitioned preset. Absent means today's walls and floor. */
export const ROOM_SHELLS = ["dungeon", "penthouse", "studio"] as const;
export const RoomShellSchema = v.picklist(ROOM_SHELLS);
export type RoomShell = v.InferOutput<typeof RoomShellSchema>;

const layoutEntries = (piece: ReturnType<typeof furniture>) => ({
  furniture: v.pipe(v.array(piece), v.maxLength(MAX_FURNITURE)),
  mood: v.optional(RoomMoodSchema),
  /** The `/thrust` + `/bendover` pair is on (OME-1671): set by the dank-dungeon preset, kept as sent. Absent means off. */
  pairs: v.optional(v.boolean()),
  /** Kept as sent, like `mood` and `pairs`. */
  shell: v.optional(RoomShellSchema),
});
type LayoutEntries = ReturnType<typeof layoutEntries>;

/** The layout's rules on top of its pieces' (ADR 0021 §3). */
const roomLayout = (base: v.ObjectSchema<LayoutEntries, undefined> | v.StrictObjectSchema<LayoutEntries, undefined>) =>
  v.pipe(
    base,
    v.check((l) => l.furniture.filter((f) => isScreen(f.kind)).length === 1, "exactly one screen"),
    v.check((l) => l.furniture.filter((f) => f.kind === "door").length <= MAX_DOORS, "too many doors"),
    v.check((l) => [0, 2].includes(l.furniture.filter((f) => f.kind === "pad").length), "0 or 2 pads"),
    v.check((l) => layoutSeats(l).length === SEAT_COUNT, "seat cells must total SEAT_COUNT"),
    v.check((l) => disjoint(l.furniture, "object"), "solid pieces overlap"),
    v.check((l) => disjoint(l.furniture, "floor"), "rugs overlap"),
    v.check((l) => disjoint(l.furniture, "wall"), "wall pieces share a segment"),
    v.check((l) => onePartitionLine(l.furniture), "more than one partition line"),
  );

/** Server → client (snapshot, `layout-changed`): unknown keys are stripped so the server can add fields. */
export const RoomLayoutSchema = roomLayout(v.object(layoutEntries(FurnitureSchema)));
export type RoomLayout = v.InferOutput<typeof RoomLayoutSchema>;

/** Client → server (`layout-set`, ADR 0028): the same rules, but unknown keys are refused, on the layout and on each piece. */
export const RoomLayoutInputSchema = roomLayout(v.strictObject(layoutEntries(furniture(v.strictObject(FURNITURE_ENTRIES)))));

/** A door of `layout` leads to `roomId`. The server refuses a `layout-set` with a door to its own room (ADR 0054). */
export function hasDoorTo(layout: { readonly furniture: readonly { readonly target?: RoomId | undefined }[] }, roomId: RoomId): boolean {
  return layout.furniture.some((f) => f.target === roomId);
}

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
