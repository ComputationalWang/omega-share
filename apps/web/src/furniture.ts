// The room's furniture as a scene: seats, standing spots and set (g) sprites with their depth, from snapshot.room.layout
// (ADR 0021). Pure, no Pixi: room-view.ts draws it, furniture-atlas.ts loads the set (g) sheet, furniture-v2-atlas.ts
// catalogue v2 (OME-1113), furniture-v4-atlas.ts batch 6 (OME-1439) and furniture-v5-atlas.ts the theatre set (OME-1630), each only when a layout needs it, room-atlas.ts the room sheet (planks, back walls and the room-atlas kinds, OME-1062) for every room.
import * as v from "valibot";
import { DEFAULT_LAYOUT, FLOOR_CELLS, FURNITURE, MAX_ROOM_MEMBERS, footprintCells, layoutSeats, type Facing, type Furniture, type FurnitureKind, type LieStyle, type RoomId, type RoomLayout, type RoomState } from "@omega/shared";
import { STAGE_W, TURN, cellCenter, isNorth, rawCenter, type Point } from "./layout";
import { recolourKey, recolourOf } from "./recolours";
import { lieOffset } from "./walk/lie";
import { cellOf, colOf, rowOf } from "./walk/path";

/**
 * A layout's content as a string: each piece's fields in a fixed order, an absent variant as 0. Two layouts with the same
 * key draw the same room, however their objects were written (a parsed snapshot, a recolour back to variant 0).
 */
export const layoutKey = (l: RoomLayout): string => l.furniture.map((f) => `${f.kind} ${String(f.col)} ${String(f.row)} ${f.facing} ${String(f.variant ?? 0)} ${f.target ?? ""}`).join(";");
/** What the stage redraws on: the layout key and the mood (the night pane mask, OME-1991). */
export const sceneKey = (l: RoomLayout): string => `${layoutKey(l)}|${l.mood === "night" ? "night" : ""}`;
/** The classic preset's layout key (OME-1186): its rooms get the holiday theme's decor. */
const CLASSIC_KEY = layoutKey(DEFAULT_LAYOUT);

/** The pieces the room atlas draws (placeholder floor and seat markers until it loads); everything else is set (g). */
const ROOM_KINDS: ReadonlySet<FurnitureKind> = new Set(["armchair", "tv", "lamp", "plant", "rug"]);
/** Catalogue v2's pieces (assets/furniture/furniture-v2.json, its own lazy sheet). */
const V2_KINDS: ReadonlySet<FurnitureKind> = new Set(["floorcushion", "bench", "turntable", "speaker", "cat", "wallshelf", "garland", "coffeetable", "pouf", "neonsign", "aquarium", "arcade", "wallclock", "door"]);
/** Batch 6's pieces (assets/furniture/furniture-v4.json, its own lazy sheet). */
const V4_KINDS: ReadonlySet<FurnitureKind> = new Set(["hammock", "stool", "barcounter", "piano", "fireplace"]);
/** The theatre set's pieces (assets/furniture/furniture-v5.json, its own lazy sheet). */
const V5_KINDS: ReadonlySet<FurnitureKind> = new Set(["theatrerow", "curtain", "bigscreen", "aislelight", "carpet"]);
/** A theatre row's riser by variant, px a sitter is drawn higher (furniture-v5.json `seatLiftByColour`, pinned by a test). */
const RISER_LIFT: readonly number[] = [0, 10, 20];
/** The Dank Dungeon's pieces (assets/furniture/furniture-v6.json, its own lazy sheet, OME-1672). */
const V6_KINDS: ReadonlySet<FurnitureKind> = new Set(["bed", "whirlpool", "mirror", "minibar", "desk", "washbasin", "partition"]);
/** The reworked room's own pieces (assets/furniture/furniture-v7.json, its own lazy sheet, OME-1991); it also holds single colours of older kinds (`V7_COLOURS`). */
const V7_KINDS: ReadonlySet<FurnitureKind> = new Set(["sauna", "soaktub", "lounger"]);
/** The glass partitions (glass, panelglass): at night their pane gets v7's amber mask (assets/README.md "Night pane masks"). */
const GLASS: ReadonlySet<number> = new Set([1, 3]);
const PANE_ALPHA = 0.2;
const glassAtNight = (l: RoomLayout, f: Furniture): boolean => l.mood === "night" && f.kind === "partition" && GLASS.has(f.variant ?? 0);
/** The dungeon shell's interior wall row: carpet (bedroom) before it, deck (spa) after, and the left wall's `split` segment on it (assets/README.md "Shell skin"). */
const DUNGEON_SPLIT = 4;
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
          /** The "in use" loop (OME-1405): frame count and ms per frame; its frames are `meta.omega.useKey`. */
          use: v.optional(v.object({ frames: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(16)), ms: v.pipe(v.number(), v.minValue(16)) })),
          /** A door (OME-1424): an open frame, `furniture/<id>/<colour>/open/<dir>`, same rect and anchor as the closed back frame. */
          open: v.optional(v.boolean()),
          /** A piece that wanders (the cat, OME-1520): its walk loop; frames `meta.omega.walkKey`, `sitKey`, and `bedKey` for the empty bed. */
          /** An interior wall (OME-1959): its cut-down stub, `furniture/<id>/<colour>/cut/<dir>`, with its own rect and anchor. */
          cut: v.optional(v.boolean()),
          walk: v.optional(v.object({ frames: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(16)), ms: v.pipe(v.number(), v.minValue(16)) })),
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
  return layout.furniture.some((f) => !ROOM_KINDS.has(f.kind) && !V2_KINDS.has(f.kind) && !V4_KINDS.has(f.kind) && !V5_KINDS.has(f.kind) && !V6_KINDS.has(f.kind) && !V7_KINDS.has(f.kind));
}

/** True if the layout holds a catalogue v2 piece, i.e. the v2 sheet must load. */
export function usesV2(layout: RoomLayout): boolean {
  return layout.furniture.some((f) => V2_KINDS.has(f.kind));
}

/** True if the layout holds a batch 6 piece, i.e. the v4 sheet must load. */
export function usesV4(layout: RoomLayout): boolean {
  return layout.furniture.some((f) => V4_KINDS.has(f.kind));
}

/** True if the layout holds a Dank Dungeon piece, i.e. the v6 sheet must load. */
export function usesV6(layout: RoomLayout): boolean {
  return layout.furniture.some((f) => V6_KINDS.has(f.kind));
}

/** v7's colours of older kinds (and the tv), `"<id>/<colour>"` → variant; the older sheets keep the lower variants (pinned to furniture-v7.json by a test). */
export const V7_COLOURS: Readonly<Record<string, number>> = { "mirror/silver": 1, "minibar/fridge": 1, "carpet/oval": 1, "tv/flat": 1, "partition/panel": 2, "partition/panelglass": 3 };
/** Each older kind's first v7 variant. */
const V7_FROM = new Map<string, number>();
for (const [k, n] of Object.entries(V7_COLOURS)) {
  const id = k.slice(0, k.indexOf("/"));
  V7_FROM.set(id, Math.min(n, V7_FROM.get(id) ?? n));
}

/** True if the layout needs the v7 sheet: a v7 kind, an older kind at a v7 variant, the dungeon shell skin, or a glass partition at night (its pane). */
export function usesV7(layout: RoomLayout): boolean {
  return layout.shell === "dungeon" || layout.furniture.some((f) => V7_KINDS.has(f.kind) || (f.variant ?? 0) >= (V7_FROM.get(f.kind) ?? Infinity) || glassAtNight(layout, f));
}

/** True if the layout holds a theatre piece, i.e. the v5 sheet must load. */
export function usesV5(layout: RoomLayout): boolean {
  return layout.furniture.some((f) => V5_KINDS.has(f.kind));
}

/** Where a sitter on `f`'s seat cell (col, row) is drawn: the cell centre, raised by a theatre row's riser. */
function seatAt(f: Furniture, col: number, row: number): Point {
  const p = cellCenter(col, row);
  const lift = f.kind === "theatrerow" ? (RISER_LIFT[f.variant ?? 0] ?? 0) : 0;
  return lift === 0 ? p : { x: p.x, y: p.y - lift };
}

/** The cells of `f` that seat someone: layoutSeats' (a piece seats along its first row only, ADR 0057), so seat i is one cell everywhere. */
export const seatCells = (f: Furniture): [number, number][] => layoutSeats({ furniture: [f] }).map((s) => [s.col, s.row]);

/** Seat i's floor point (ADR 0021: the i-th seat cell across seat pieces, in furniture order). */
export function seatPoints(layout: RoomLayout): Point[] {
  return layout.furniture.flatMap((f) => seatCells(f).map(([c, r]) => seatAt(f, c, r)));
}

/** Seat i's facing in my view: from the north (OME-1961) a sitter turns with their chair (OME-2039). */
export const seatFacings = (layout: RoomLayout): Facing[] => layoutSeats(layout).map((s) => (isNorth() ? TURN[s.facing] : s.facing));

/** Seat i's floor tile, without the riser lift: where its key sits, so a riser's key doesn't cover the row in front. */
export function seatTiles(layout: RoomLayout): Point[] {
  return layout.furniture.flatMap((f) => seatCells(f).map(([c, r]) => cellCenter(c, r)));
}

/** Rows (col + row) for people without a seat, front of the room first, each from its middle out, filled in order. */
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
    const line: Point[] = [];
    for (let col = 0; col < FLOOR_CELLS; col++) {
      const row = sum - col;
      if (row >= 0 && row < FLOOR_CELLS && !blocked.has(col * FLOOR_CELLS + row)) line.push(cellCenter(col, row));
    }
    // Middle out (OME-1930): who just joined stands in front of the TV, in a phone's window with the seats.
    spots.push(...line.sort((a, b) => Math.abs(a.x - STAGE_W / 2) - Math.abs(b.x - STAGE_W / 2)));
  }
  return spots.slice(0, MAX_ROOM_MEMBERS);
}

/** The pieces with an "in use" loop (OME-1405, OME-1437 art, assets/README.md), by what sets it off: someone standing at
 * their front, someone sitting in them, a video playing. */
const FRONT_KINDS: ReadonlySet<FurnitureKind> = new Set(["arcade", "turntable", "aquarium", "neonsign", "door", "piano"]);
/** A teleport pad (OME-1548) is lit while someone stands on its own cell. */
const ON_KINDS: ReadonlySet<FurnitureKind> = new Set(["pad"]);
const SEATED_KINDS: ReadonlySet<FurnitureKind> = new Set(["hammock"]);
const PLAYING_KINDS: ReadonlySet<FurnitureKind> = new Set(["neonsign", "fireplace"]);
/** A one-frame "loop" never steps; the frame time only has to be a valid one. */
const OPEN_MS = 3_600_000;
/** From a piece's cell to the one at its front: +col is se, +row is sw on screen (cellCenter). */
const FRONT: Readonly<Record<Facing, readonly [number, number]>> = { se: [1, 0], sw: [0, 1], ne: [0, -1], nw: [-1, 0] };
const NOBODY: ReadonlySet<number> = new Set();

/**
 * Indices of the layout's pieces in use (OME-1407, OME-1439): someone stands on a cell at the front of a front piece (any
 * footprint cell's; a wall piece's front is the floor cell under it), someone sits in a seated piece, or a video plays.
 * `standing` and `seated` hold walk cells (`cellOf`). Worked out when someone moves or the layout changes, never per frame.
 */
export function piecesInUse(layout: RoomLayout, standing: ReadonlySet<number>, playing: boolean, seated: ReadonlySet<number> = NOBODY, cut = false): Set<number> {
  const out = new Set<number>();
  layout.furniture.forEach((f, i) => {
    if (f.kind === "partition") {
      if (cut) out.add(i);
    } else if (playing && PLAYING_KINDS.has(f.kind)) out.add(i);
    else if (ON_KINDS.has(f.kind)) {
      if (standing.has(cellOf(f.col, f.row))) out.add(i);
    } else if (SEATED_KINDS.has(f.kind) && footprintCells(f).some(([c, r]) => seated.has(cellOf(c, r)))) out.add(i);
    else if (FRONT_KINDS.has(f.kind)) {
      const wall = FURNITURE[f.kind].layer === "wall";
      const [dc, dr] = wall ? [0, 0] : FRONT[f.facing];
      const cells: [number, number][] = wall ? [[f.col, f.row]] : footprintCells(f);
      const near = cells.some(([col, row]) => {
        const c = col + dc;
        const r = row + dr;
        return c >= 0 && c < FLOOR_CELLS && r >= 0 && r < FLOOR_CELLS && standing.has(cellOf(c, r));
      });
      if (near) out.add(i);
    }
  });
  return out;
}

/**
 * The partitions are cut down for this viewer (OME-1960): my cell `self` is behind a partition (a smaller row than a row
 * of them, facing sw; a smaller col than a col of them, facing se). On a partition's own line (the doorway), or with no
 * avatar of mine, it stays `was`. Worked out on a walk event, never per frame.
 */
export function cutaway(layout: RoomLayout, self: number | null, was: boolean): boolean {
  // shortcut: one verdict cuts every partition (phase A has one wall); go per wall if a layout ever has two.
  const wall = layout.furniture.find((f) => f.kind === "partition");
  if (wall === undefined) return false;
  if (self === null) return was;
  const [mine, line] = wall.facing === "se" ? [colOf(self), wall.col] : [rowOf(self), wall.row];
  return mine === line ? was : mine < line;
}

/** True if the layout has a partition, i.e. the back-view sheet must load (OME-1961). */
export function usesBack(layout: RoomLayout): boolean {
  return layout.furniture.some((f) => f.kind === "partition");
}

/** My view of a partitioned room (OME-1961): `behind` the wall (cutaway's verdict), `north` (seen from the other side), `cut` (the stubs, the fallback). */
export interface ViewVerdict {
  readonly behind: boolean;
  readonly north: boolean;
  readonly cut: boolean;
}
/** Behind the wall I see the room from the north once the back sheet is `ready`, else through phase A's stubs; editing is always south, uncut. */
export function viewVerdict(layout: RoomLayout, self: number | null, was: boolean, editing: boolean, ready: boolean): ViewVerdict {
  const behind = cutaway(layout, self, was);
  const turned = behind && !editing;
  return { behind, north: turned && ready, cut: turned && !ready };
}

/** The room a door leads to (OME-1425), if `(col, row)` is the cell in front of one of the layout's doors. */
export function doorAt(layout: RoomLayout, col: number, row: number): RoomId | null {
  for (const f of layout.furniture) {
    if (f.kind !== "door" || f.target === undefined) continue;
    const [dc, dr] = FRONT[f.facing];
    if (f.col + dc === col && f.row + dr === row) return f.target;
  }
  return null;
}

/** The cat's frames (OME-1520): its art has se and sw only, so ne walks use se and nw use sw. */
export interface CatWalker {
  readonly piece: number;
  readonly home: number;
  readonly walk: { readonly se: readonly string[]; readonly sw: readonly string[] };
  readonly sit: { readonly se: string; readonly sw: string };
  readonly bed: string;
  readonly ms: number;
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
  /** An "in use" loop (OME-1407): the furniture index, the loop's frame keys and its frame time. */
  readonly use?: { readonly piece: number; readonly frames: readonly string[]; readonly ms: number };
  /** A piece that wanders (the cat, OME-1520): its furniture index, home cell, walk frames per drawn facing, sit frames, empty bed frame and walk frame time. */
  readonly walker?: CatWalker;
  /** Drawn translucent (the night pane mask); absent is opaque. */
  readonly alpha?: number;
}

export interface SceneSeat {
  readonly at: Point;
  /** Depth of whoever sits here: their piece's sort point (sitters sort with their seat's piece), or their cell. */
  readonly z: number;
  /** Draw the placeholder seat marker (room-atlas armchairs before the room atlas loads); otherwise the seat is its piece. */
  readonly marker: boolean;
}

const SLEEPERS = [0, 1] as const;

/** Where someone lies on a piece (OME-1691): their floor point, the piece's anchor, and their depth (the piece's sort point, between its back and front). */
export interface LieSpot {
  readonly style: LieStyle;
  readonly dir: Facing;
  readonly at: Point;
  readonly anchor: Point;
  readonly z: number;
  /** The queen bed's duvet over this sleeper (OME-2009): its frame, drawn at `anchor` just over them. Absent: nothing to pull up. */
  readonly cover?: { readonly key: string; readonly z: number };
}

export interface Scene {
  /** By layout piece index: the pieces someone can lie on, a spot per lier it takes (index: `Member.sleeper`, else 0). */
  readonly lies: ReadonlyMap<number, readonly LieSpot[]>;
  readonly sprites: readonly FurnitureSprite[];
  readonly seats: readonly SceneSeat[];
  /** The layout is the classic preset's (= DEFAULT_LAYOUT; the preset id never reaches the client): theme decor goes here. */
  readonly classic: boolean;
}

type Piece = FurnitureManifest["meta"]["omega"]["pieces"][number];
/** A piece and the colour (name) one variant of it draws. */
interface Colour {
  readonly piece: Piece;
  readonly colour: string;
}

/**
 * What to draw for `layout`, from the catalogue manifests loaded so far (set (g), v2: same schema, ids don't collide).
 * A piece whose manifest isn't loaded (not yet, or not needed) is left out and its
 * sitters sort by their own cell; without the room manifest, so are the floor, walls and room-atlas kinds. Built once per
 * layout change, never per frame.
 */
export function sceneOf(layout: RoomLayout, manifests: readonly FurnitureManifest[], room: RoomManifest | null = null, back: FurnitureManifest | null = null): Scene {
  // From the north (OME-1961) a piece faces the other way, anchored at its far corner, and wall pieces go with the near walls.
  const north = isNorth();
  // By `<id>/<variant>`: a colour's variant is its index in its sheet, except v7's colours of older kinds (V7_COLOURS).
  const pieces = new Map<string, Colour>(manifests.flatMap((m) => m.meta.omega.pieces.flatMap((p) => p.colours.map((colour, n) => [`${p.id}/${String(V7_COLOURS[`${p.id}/${colour}`] ?? n)}`, { piece: p, colour }] as const))));
  const layers = manifests[0]?.meta.omega.layers;
  const sprites: FurnitureSprite[] = [];
  const seats: SceneSeat[] = [];
  const lies = new Map<number, readonly LieSpot[]>();
  // The dungeon shell skin needs v7's frames; a layout that asks for it before they load keeps today's shell.
  if (room !== null) pushShell(sprites, layout, room, layout.shell === "dungeon" && manifests.some((m) => m.frames["floor/deck/0"] !== undefined));
  for (const [i, source] of layout.furniture.entries()) {
    const spec = FURNITURE[source.kind];
    if (north && spec.layer === "wall") continue;
    const f = north ? { ...source, facing: TURN[source.facing] } : source;
    const id = atlasId(f.kind);
    // A variant its sheets lack (not loaded yet, or a recolour, which draws its source's frames) falls back to the piece's first colour; the tv has none, only its console.
    const found = pieces.get(`${id}/${String(f.variant ?? 0)}`) ?? (f.kind === "tv" ? undefined : pieces.get(`${id}/0`));
    const piece = ROOM_KINDS.has(f.kind) ? undefined : found?.piece;
    const anchor = north ? farCorner(source) : cellCenter(f.col, f.row);
    // A one-sided piece seen from the north: its source facing's sort point, reflected; its frames come from the back sheet, else its own source frames.
    const own = piece?.sortByDir[f.facing];
    const reflected = north && own === undefined ? piece?.sortByDir[source.facing] : undefined;
    const sort = reflected === undefined ? own : { x: cellCenter(f.col, f.row).x - reflected.x - anchor.x, y: cellCenter(f.col, f.row).y - reflected.y - anchor.y };
    const backKey = (colour: string): string => `furniture/${id}/${colour}/${f.facing}/back`;
    const fromBack = reflected !== undefined && found !== undefined && back?.frames[backKey(found.colour)] !== undefined;
    const drawn = piece !== undefined && found !== undefined && sort !== undefined && layers !== undefined ? { piece, colour: found.colour, sort, layers } : null;
    const style = spec.lie;
    if (style !== undefined) {
      const offs = SLEEPERS.flatMap((n) => lieOffset(f.kind, f.facing, n) ?? []);
      const z = drawn === null ? standDepth(anchor) : depth(anchor.x + drawn.sort.x, anchor.y + drawn.sort.y, drawn.layers.avatar);
      // Two sleepers share the bed's sort point: the one higher up the screen first, each with their cover over them (OME-2009).
      const rank = (y: number): number => offs.filter((o) => o.y < y).length;
      const spots = offs.map((off, n): LieSpot => {
        const at = { x: anchor.x + off.x, y: anchor.y + off.y };
        const own = z + rank(off.y) * 0.5;
        return { style, dir: f.facing, at, anchor, z: own, ...(style === "sleep" && drawn !== null ? { cover: { key: `furniture/${id}/${drawn.colour}/cover/${f.facing}/${String(n)}`, z: own + 0.25 } } : {}) };
      });
      if (spots.length > 0) lies.set(i, spots);
    }
    if (drawn !== null && fromBack) {
      for (const part of drawn.piece.layersByDir[source.facing] ?? []) {
        const key = `furniture/${id}/${drawn.colour}/${f.facing}/${part}`;
        if (back.frames[key] !== undefined) sprites.push({ key, x: anchor.x, y: anchor.y, layer: spec.layer, z: depth(anchor.x + drawn.sort.x, anchor.y + drawn.sort.y, drawn.layers[part]) });
      }
    } else if (drawn !== null) {
      pushSprites(sprites, reflected === undefined ? f : source, i, anchor, drawn, !north);
      // Same rect, anchor and depth as the back frame, pushed after it: the stable sort keeps it on top.
      if (glassAtNight(layout, f)) sprites.push({ key: `furniture/partition/${drawn.colour}/pane/${f.facing}`, x: anchor.x, y: anchor.y, layer: FURNITURE[f.kind].layer, z: depth(anchor.x + drawn.sort.x, anchor.y + drawn.sort.y, drawn.layers.back), alpha: PANE_ALPHA });
    }
    // The flat tv (v7, variant 1) takes the console's place: same anchor, layer and depth, its own frame.
    else if (north && f.kind === "tv" && back?.frames[backKey(found?.colour ?? "charcoal")] !== undefined) {
      // The console's back stands near the camera; the one player shows on a flat tv at the far corner (CEO, OME-1961).
      sprites.push({ key: backKey(found?.colour ?? "charcoal"), x: anchor.x, y: anchor.y, layer: "object", z: depth(anchor.x, anchor.y, BACK_LAYER) });
      const screen = rawCenter(0, 0);
      sprites.push({ key: "furniture/tv/flat/se/back", x: screen.x, y: screen.y, layer: "wall", z: depth(screen.x, screen.y, BACK_LAYER) });
    } else if (room !== null) pushRoomPiece(sprites, f, anchor, f.kind === "tv" && found !== undefined ? `furniture/tv/${found.colour}/${f.facing}/back` : "tv/0");
    if (!spec.seats) continue;
    for (const [c, r] of seatCells(f)) {
      const at = seatAt(f, c, r);
      // Cells further from the anchor are nearer the camera (+col and +row both step down the screen).
      const near = (north ? -1 : 1) * (c - f.col + (r - f.row));
      const z = drawn === null ? standDepth(at) : depth(anchor.x + drawn.sort.x, anchor.y + drawn.sort.y, drawn.layers.avatar, near);
      seats.push({ at, z, marker: f.kind === "armchair" && room === null });
    }
  }
  return { lies, sprites, seats, classic: layoutKey(layout) === CLASSIC_KEY };
}

function pushSprites(
  out: FurnitureSprite[],
  f: Furniture,
  index: number,
  anchor: Point,
  { piece, colour, sort, layers }: { readonly piece: Piece; readonly colour: string; readonly sort: { readonly x: number; readonly y: number }; readonly layers: FurnitureManifest["meta"]["omega"]["layers"] },
  states = true,
): void {
  const variant = f.variant ?? 0;
  // A new colour (OME-1463) draws its source colour's frames from that sheet's recoloured copy.
  const recolour = recolourOf(f.kind, variant);
  const prefix = recolour?.frames ?? `furniture/${piece.id}/${colour}/`;
  const frame = (rest: string): string => (recolour === undefined ? prefix + rest : recolourKey(f.kind, variant, prefix + rest));
  const layer = FURNITURE[f.kind].layer;
  for (const part of piece.layersByDir[f.facing] ?? []) {
    out.push({
      key: frame(`${f.facing}/${part}`),
      x: anchor.x,
      y: anchor.y,
      layer,
      z: depth(anchor.x + sort.x, anchor.y + sort.y, layers[part]),
      // The loop swaps the back frame in place. An open piece (a door) or a cut one (a partition, OME-1960) has one frame: a state.
      ...(part === "back" && piece.use !== undefined
        ? { use: { piece: index, frames: Array.from({ length: piece.use.frames }, (_, n) => frame(`use/${f.facing}/${String(n)}`)), ms: piece.use.ms } }
        : part === "back" && states && (piece.open === true || piece.cut === true)
          ? { use: { piece: index, frames: [frame(`${piece.open === true ? "open" : "cut"}/${f.facing}`)], ms: OPEN_MS } }
          : part === "back" && piece.walk !== undefined
            ? { walker: walkerOf(frame, index, cellOf(f.col, f.row), f.facing, piece.walk) }
            : {}),
    });
  }
}

function walkerOf(frame: (rest: string) => string, piece: number, home: number, facing: Facing, walk: { readonly frames: number; readonly ms: number }): CatWalker {
  const loop = (dir: string): string[] => Array.from({ length: walk.frames }, (_, n) => frame(`walk/${dir}/${String(n)}`));
  return { piece, home, walk: { se: loop("se"), sw: loop("sw") }, sit: { se: frame("sit/se"), sw: frame("sit/sw") }, bed: frame(`bed/${facing}`), ms: walk.ms };
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
function pushShell(out: FurnitureSprite[], layout: RoomLayout, room: RoomManifest, skin: boolean): void {
  // The shell is drawn on the raw projection, its back walls always top-left and top-right; from the north (OME-1961) the
  // drawn cell (x, y) is the room's cell (9 − x, 9 − y), so the walls behind me are the spa's and the near ones are gone.
  const north = isNorth();
  const last = FLOOR_CELLS - 1;
  const suggested = room.meta.omega.layout;
  const rugs = layout.furniture.filter((f) => f.kind === "rug");
  const rugSize = FURNITURE.rug.cols;
  for (let y = 0; y < FLOOR_CELLS; y++) {
    for (let x = 0; x < FLOOR_CELLS; x++) {
      const [col, row] = north ? [last - x, last - y] : [x, y];
      const rug = rugs.find((f) => col >= f.col && col < f.col + rugSize && row >= f.row && row < f.row + rugSize);
      const plank = suggested.floor[row]?.[col] ?? "";
      const [dc, dr] = rug === undefined ? [0, 0] : north ? [rugSize - 1 - (col - rug.col), rugSize - 1 - (row - rug.row)] : [col - rug.col, row - rug.row];
      const part = rug === undefined ? "" : `rug/${rugPart(dc, dr, rugSize - 1)}`;
      const recoloured = rug !== undefined && recolourOf("rug", rug.variant ?? 0) !== undefined;
      const split = north ? "split/north" : "split";
      const base = skin ? `floor/${row < DUNGEON_SPLIT ? "carpet" : row === DUNGEON_SPLIT ? split : "deck"}/${String((col + row) % 2)}` : plank.startsWith("floor/") ? plank : "floor/0";
      const key = rug === undefined ? base : recoloured ? recolourKey("rug", rug.variant ?? 0, part) : part;
      out.push(shellSprite(key, x, y, "floor"));
    }
  }
  const printL = !north && layout.furniture.some((f) => FURNITURE[f.kind].layer === "wall" && f.facing === "se");
  const printR = !north && layout.furniture.some((f) => FURNITURE[f.kind].layer === "wall" && f.facing === "sw");
  for (let i = 0; i < FLOOR_CELLS; i++) {
    const row = north ? last - i : i;
    // The skin's segments carry wall pieces as they are, so no plain swap.
    const l = skin ? `wall/l/${row < DUNGEON_SPLIT ? "oak" : row === DUNGEON_SPLIT ? (north ? "split/north" : "split") : "smoke"}` : printL ? "wall/l/plain" : (suggested.walls.l[i] ?? "wall/l/plain");
    out.push(shellSprite(l, 0, i, "wall"));
    out.push(shellSprite(skin ? `wall/r/${north ? "smoke" : "oak"}` : printR ? "wall/r/plain" : (suggested.walls.r[i] ?? "wall/r/plain"), i, 0, "wall"));
  }
  const ends = skin ? (north ? ["wall/corner/smoke", "wall/l/end/oak", "wall/r/end/smoke"] : ["wall/corner/oak", "wall/l/end/smoke", "wall/r/end/oak"]) : ["wall/corner", "wall/l/end", "wall/r/end"];
  out.push(shellSprite(ends[0] ?? "", 0, 0, "wall"), shellSprite(ends[1] ?? "", 0, FLOOR_CELLS - 1, "wall"), shellSprite(ends[2] ?? "", FLOOR_CELLS - 1, 0, "wall"));
}

/** A piece's far corner from the north: its footprint's largest col and row, the back-most cell once turned. */
function farCorner(f: Furniture): Point {
  let col = f.col;
  let row = f.row;
  for (const [c, r] of footprintCells(f)) {
    col = Math.max(col, c);
    row = Math.max(row, r);
  }
  return cellCenter(col, row);
}

function shellSprite(key: string, col: number, row: number, layer: "floor" | "wall"): FurnitureSprite {
  const p = rawCenter(col, row);
  return { key, x: p.x, y: p.y, layer, z: 0 };
}

/** A room-atlas piece on its cell: armchairs back and front around the sitter, the console with the walls, props sorted. */
function pushRoomPiece(out: FurnitureSprite[], f: Furniture, a: Point, tvKey: string): void {
  const at = (key: string, layer: FurnitureSprite["layer"], z: number): void => {
    out.push({ key, x: a.x, y: a.y, layer, z: depth(a.x, a.y, z) });
  };
  if (f.kind === "armchair") {
    at(`armchair/${f.facing}/back`, "object", BACK_LAYER);
    at(`armchair/${f.facing}/front`, "object", FRONT_LAYER);
  } else if (f.kind === "tv") at(tvKey, "wall", BACK_LAYER);
  else if (f.kind === "lamp" || f.kind === "plant") {
    const variant = f.variant ?? 0;
    const key = `${f.kind}/0`;
    at(recolourOf(f.kind, variant) === undefined ? key : recolourKey(f.kind, variant, key), "object", BACK_LAYER);
  }
}
