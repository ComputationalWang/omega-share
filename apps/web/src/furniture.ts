// The room's furniture as a scene: seats, standing spots and set (g) sprites with their depth, from snapshot.room.layout
// (ADR 0021). Pure, no Pixi: room-view.ts draws it, furniture-atlas.ts loads the set (g) sheet and furniture-v2-atlas.ts
// catalogue v2 (OME-1113), each only when a layout needs it, room-atlas.ts the room sheet (planks, back walls and the room-atlas kinds, OME-1062) for every room.
import * as v from "valibot";
import { DEFAULT_LAYOUT, FLOOR_CELLS, FURNITURE, MAX_ROOM_MEMBERS, footprintCells, layoutSeats, type Furniture, type FurnitureKind, type RoomLayout, type RoomState } from "@omega/shared";
import { cellCenter, type Point } from "./layout";

/**
 * A layout's content as a string: each piece's fields in a fixed order, an absent variant as 0. Two layouts with the same
 * key draw the same room, however their objects were written (a parsed snapshot, a recolour back to variant 0).
 */
export const layoutKey = (l: RoomLayout): string => l.furniture.map((f) => `${f.kind} ${String(f.col)} ${String(f.row)} ${f.facing} ${String(f.variant ?? 0)}`).join(";");

/** The pieces the room atlas draws (placeholder floor and seat markers until it loads); everything else is set (g). */
const ROOM_KINDS: ReadonlySet<FurnitureKind> = new Set(["armchair", "tv", "lamp", "plant", "rug"]);
/** Catalogue v2's pieces (assets/furniture/furniture-v2.json, its own lazy sheet). */
const V2_KINDS: ReadonlySet<FurnitureKind> = new Set(["floorcushion", "bench", "turntable", "speaker", "cat", "wallshelf", "garland"]);
/** Set (g)'s kilim runner is atlas id `rug` (layout.ts in @omega/shared). */
const atlasId = (kind: FurnitureKind): string => (kind === "runner" ? "rug" : kind);

const DIR = v.picklist(["ne", "nw", "se", "sw"]);
const XY = v.object({ x: v.number(), y: v.number() });
/** The parts of `assets/furniture/furniture.json` the room reads (assets/README.md "Furniture atlas"). */
export const FurnitureManifestSchema = v.object({
  frames: v.record(v.string(), v.object({ frame: v.object({ x: v.number(), y: v.number(), w: v.number(), h: v.number() }), anchor: XY })),
  meta: v.object({
    omega: v.object({
      layers: v.object({ back: v.number(), avatar: v.number(), front: v.number() }),
      pieces: v.array(
        v.object({
          id: v.string(),
          colours: v.pipe(v.array(v.string()), v.minLength(1)),
          sortByDir: v.record(DIR, v.optional(XY)),
          layersByDir: v.record(DIR, v.optional(v.array(v.picklist(["back", "front"])))),
        }),
      ),
    }),
  }),
});
export type FurnitureManifest = v.InferOutput<typeof FurnitureManifestSchema>;

/** The parts of `assets/room/room.json` the room reads (assets/README.md "Room atlas"). */
export const RoomManifestSchema = v.object({
  frames: v.record(v.string(), v.object({ frame: v.object({ x: v.number(), y: v.number(), w: v.number(), h: v.number() }), anchor: XY })),
  meta: v.object({
    omega: v.object({
      layout: v.object({ floor: v.array(v.array(v.string())), walls: v.object({ l: v.array(v.string()), r: v.array(v.string()) }) }),
    }),
  }),
});
export type RoomManifest = v.InferOutput<typeof RoomManifestSchema>;

/** `meta.omega.layers` (back 2, avatar 3, front 4); fixed by the art contract, so a client without the atlas sorts the same. */
const BACK_LAYER = 2;
const AVATAR_LAYER = 3;
const FRONT_LAYER = 4;

/**
 * Depth for zIndex: by floor y, then x, then layer (assets/README.md), then `near` (which sitter on a multi-seat piece:
 * sitters share their piece's sort point, so the nearer one breaks the tie). Stage px are whole numbers well inside 4096.
 */
function depth(x: number, y: number, layer: number, near = 0): number {
  return ((Math.round(y) * 4096 + Math.round(x) + 1024) * 8 + layer) * 8 + near;
}

/** Depth of an avatar standing (or sitting on a placeholder seat) at `p`. */
export const standDepth = (p: Point): number => depth(p.x, p.y, AVATAR_LAYER);

/** The room's layout, or DEFAULT_LAYOUT from a pre-M4 server (or before the snapshot). */
export function layoutOf(room: RoomState | null): RoomLayout {
  return room?.layout ?? DEFAULT_LAYOUT;
}

/** True if the layout holds a set (g) piece, i.e. the furniture atlas must load. */
export function usesSetG(layout: RoomLayout): boolean {
  return layout.furniture.some((f) => !ROOM_KINDS.has(f.kind) && !V2_KINDS.has(f.kind));
}

/** True if the layout holds a catalogue v2 piece, i.e. the v2 sheet must load. */
export function usesV2(layout: RoomLayout): boolean {
  return layout.furniture.some((f) => V2_KINDS.has(f.kind));
}

/** Seat i's floor point (ADR 0021: the i-th seat cell across seat pieces, in furniture order). */
export function seatPoints(layout: RoomLayout): Point[] {
  return layoutSeats(layout).map((s) => cellCenter(s.col, s.row));
}

/** Rows (col + row) for people without a seat, front of the room first, filled in order. */
const STANDING_SUMS = [13, 15, 17, 12, 14, 16, 18, 11, 10, 9, 8, 7];

/** Spots for members without a seat: the front of the room, off solid pieces and seats. */
export function standingPoints(layout: RoomLayout): Point[] {
  const blocked = new Set<number>();
  for (const f of layout.furniture) {
    if (FURNITURE[f.kind].layer !== "object") continue;
    for (const [c, r] of footprintCells(f)) blocked.add(c * FLOOR_CELLS + r);
  }
  const spots: Point[] = [];
  for (const sum of STANDING_SUMS) {
    for (let col = 0; col < FLOOR_CELLS; col++) {
      const row = sum - col;
      if (row >= 0 && row < FLOOR_CELLS && !blocked.has(col * FLOOR_CELLS + row)) spots.push(cellCenter(col, row));
    }
  }
  return spots.slice(0, MAX_ROOM_MEMBERS);
}

export interface FurnitureSprite {
  /** Frame key in the furniture atlas. */
  readonly key: string;
  /** The anchor cell's floor point; the frame's own anchor lands here. */
  readonly x: number;
  readonly y: number;
  /** `floor` and `wall` draw with the static background in furniture order; `object` sorts with avatars by `z`. */
  readonly layer: "floor" | "wall" | "object";
  readonly z: number;
}

export interface SceneSeat {
  readonly at: Point;
  /** Depth of whoever sits here: their piece's sort point (sitters sort with their seat's piece), or their cell. */
  readonly z: number;
  /** Draw the placeholder seat marker (room-atlas armchairs before the room atlas loads); otherwise the seat is its piece. */
  readonly marker: boolean;
}

export interface Scene {
  readonly sprites: readonly FurnitureSprite[];
  readonly seats: readonly SceneSeat[];
}

type Piece = FurnitureManifest["meta"]["omega"]["pieces"][number];

/**
 * What to draw for `layout`, from the catalogue manifests loaded so far (set (g), v2: same schema, ids don't collide).
 * A piece whose manifest isn't loaded (not yet, or not needed) is left out and its
 * sitters sort by their own cell; without the room manifest, so are the floor, walls and room-atlas kinds. Built once per
 * layout change, never per frame.
 */
export function sceneOf(layout: RoomLayout, manifests: readonly FurnitureManifest[], room: RoomManifest | null = null): Scene {
  const pieces = new Map<string, Piece>(manifests.flatMap((m) => m.meta.omega.pieces.map((p) => [p.id, p] as const)));
  const layers = manifests[0]?.meta.omega.layers;
  const sprites: FurnitureSprite[] = [];
  const seats: SceneSeat[] = [];
  if (room !== null) pushShell(sprites, layout, room);
  for (const f of layout.furniture) {
    const spec = FURNITURE[f.kind];
    const piece = ROOM_KINDS.has(f.kind) ? undefined : pieces.get(atlasId(f.kind));
    const anchor = cellCenter(f.col, f.row);
    const sort = piece?.sortByDir[f.facing];
    const drawn = piece !== undefined && sort !== undefined && layers !== undefined ? { piece, sort, layers } : null;
    if (drawn !== null) pushSprites(sprites, f, anchor, drawn);
    else if (room !== null) pushRoomPiece(sprites, f, anchor);
    if (!spec.seats) continue;
    for (const [c, r] of footprintCells(f)) {
      const at = cellCenter(c, r);
      // Cells further from the anchor are nearer the camera (+col and +row both step down the screen).
      const near = c - f.col + (r - f.row);
      const z = drawn === null ? standDepth(at) : depth(anchor.x + drawn.sort.x, anchor.y + drawn.sort.y, drawn.layers.avatar, near);
      seats.push({ at, z, marker: f.kind === "armchair" && room === null });
    }
  }
  return { sprites, seats };
}

function pushSprites(
  out: FurnitureSprite[],
  f: Furniture,
  anchor: Point,
  { piece, sort, layers }: { readonly piece: Piece; readonly sort: { readonly x: number; readonly y: number }; readonly layers: FurnitureManifest["meta"]["omega"]["layers"] },
): void {
  const colour = piece.colours[f.variant ?? 0] ?? piece.colours[0] ?? "";
  const layer = FURNITURE[f.kind].layer;
  for (const part of piece.layersByDir[f.facing] ?? []) {
    out.push({
      key: `furniture/${piece.id}/${colour}/${f.facing}/${part}`,
      x: anchor.x,
      y: anchor.y,
      layer,
      z: depth(anchor.x + sort.x, anchor.y + sort.y, layers[part]),
    });
  }
}

/** The 7×7 rug's 9-slice part at offset (dc, dr): parts name the screen side of the rim (assets/README.md). */
function rugPart(dc: number, dr: number, last: number): string {
  const side = dc === 0 ? 0 : dc === last ? 2 : 1;
  if (dr === 0) return ["n", "ne", "e"][side] ?? "c";
  if (dr === last) return ["w", "sw", "s"][side] ?? "c";
  return ["nw", "c", "se"][side] ?? "c";
}

/**
 * The static shell under everything: a plank (or rug) tile per floor cell, then both back walls with the corner cap and
 * open ends (assets/README.md "Room atlas"). A wall that carries a catalogue wall piece (print, shelf, garland) is all
 * plain segments: they hang on plain, and garlands on neighbouring segments join into one string.
 */
function pushShell(out: FurnitureSprite[], layout: RoomLayout, room: RoomManifest): void {
  const suggested = room.meta.omega.layout;
  const rugs = layout.furniture.filter((f) => f.kind === "rug");
  const rugSize = FURNITURE.rug.cols;
  for (let row = 0; row < FLOOR_CELLS; row++) {
    for (let col = 0; col < FLOOR_CELLS; col++) {
      const rug = rugs.find((f) => col >= f.col && col < f.col + rugSize && row >= f.row && row < f.row + rugSize);
      const plank = suggested.floor[row]?.[col] ?? "";
      const key = rug !== undefined ? `rug/${rugPart(col - rug.col, row - rug.row, rugSize - 1)}` : plank.startsWith("floor/") ? plank : "floor/0";
      out.push(shellSprite(key, col, row, "floor"));
    }
  }
  const printL = layout.furniture.some((f) => FURNITURE[f.kind].layer === "wall" && f.facing === "se");
  const printR = layout.furniture.some((f) => FURNITURE[f.kind].layer === "wall" && f.facing === "sw");
  for (let i = 0; i < FLOOR_CELLS; i++) {
    out.push(shellSprite(printL ? "wall/l/plain" : (suggested.walls.l[i] ?? "wall/l/plain"), 0, i, "wall"));
    out.push(shellSprite(printR ? "wall/r/plain" : (suggested.walls.r[i] ?? "wall/r/plain"), i, 0, "wall"));
  }
  out.push(shellSprite("wall/corner", 0, 0, "wall"), shellSprite("wall/l/end", 0, FLOOR_CELLS - 1, "wall"), shellSprite("wall/r/end", FLOOR_CELLS - 1, 0, "wall"));
}

function shellSprite(key: string, col: number, row: number, layer: "floor" | "wall"): FurnitureSprite {
  const p = cellCenter(col, row);
  return { key, x: p.x, y: p.y, layer, z: 0 };
}

/** A room-atlas piece on its cell: armchairs back and front around the sitter, the console with the walls, props sorted. */
function pushRoomPiece(out: FurnitureSprite[], f: Furniture, a: Point): void {
  const at = (key: string, layer: FurnitureSprite["layer"], z: number): void => {
    out.push({ key, x: a.x, y: a.y, layer, z: depth(a.x, a.y, z) });
  };
  if (f.kind === "armchair") {
    at(`armchair/${f.facing}/back`, "object", BACK_LAYER);
    at(`armchair/${f.facing}/front`, "object", FRONT_LAYER);
  } else if (f.kind === "tv") at("tv/0", "wall", BACK_LAYER);
  else if (f.kind === "lamp" || f.kind === "plant") at(`${f.kind}/0`, "object", BACK_LAYER);
}
