// The room's furniture as a scene: seats, standing spots and set (g) sprites with their depth, from snapshot.room.layout
// (ADR 0021). Pure, no Pixi: room-view.ts draws it, furniture-atlas.ts loads the set (g) sheet only when a layout needs it.
import * as v from "valibot";
import { DEFAULT_LAYOUT, FLOOR_CELLS, FURNITURE, MAX_ROOM_MEMBERS, footprintCells, layoutSeats, type Furniture, type FurnitureKind, type RoomLayout, type RoomState } from "@omega/shared";
import { cellCenter, type Point } from "./layout";

/** The pieces the room atlas draws (today as the placeholder floor and seat markers); everything else is set (g). */
const ROOM_KINDS: ReadonlySet<FurnitureKind> = new Set(["armchair", "tv", "lamp", "plant", "rug"]);
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

/** `meta.omega.layers` (back 2, avatar 3, front 4); fixed by the art contract, so a client without the atlas sorts the same. */
const AVATAR_LAYER = 3;

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
  return layout.furniture.some((f) => !ROOM_KINDS.has(f.kind));
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
  /** Draw the placeholder seat marker (room-atlas armchairs); a set (g) seat is its piece. */
  readonly marker: boolean;
}

export interface Scene {
  readonly sprites: readonly FurnitureSprite[];
  readonly seats: readonly SceneSeat[];
}

type Piece = FurnitureManifest["meta"]["omega"]["pieces"][number];

/**
 * What to draw for `layout`. Without the manifest (not loaded yet, or not needed), set (g) pieces are left out and their
 * sitters sort by their own cell. Built once per layout change, never per frame.
 */
export function sceneOf(layout: RoomLayout, manifest: FurnitureManifest | null): Scene {
  const pieces = new Map<string, Piece>((manifest?.meta.omega.pieces ?? []).map((p) => [p.id, p]));
  const layers = manifest?.meta.omega.layers;
  const sprites: FurnitureSprite[] = [];
  const seats: SceneSeat[] = [];
  for (const f of layout.furniture) {
    const spec = FURNITURE[f.kind];
    const piece = ROOM_KINDS.has(f.kind) ? undefined : pieces.get(atlasId(f.kind));
    const anchor = cellCenter(f.col, f.row);
    const sort = piece?.sortByDir[f.facing];
    const drawn = piece !== undefined && sort !== undefined && layers !== undefined ? { piece, sort, layers } : null;
    if (drawn !== null) pushSprites(sprites, f, anchor, drawn);
    if (!spec.seats) continue;
    for (const [c, r] of footprintCells(f)) {
      const at = cellCenter(c, r);
      // Cells further from the anchor are nearer the camera (+col and +row both step down the screen).
      const near = c - f.col + (r - f.row);
      const z = drawn === null ? standDepth(at) : depth(anchor.x + drawn.sort.x, anchor.y + drawn.sort.y, drawn.layers.avatar, near);
      seats.push({ at, z, marker: f.kind === "armchair" });
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
