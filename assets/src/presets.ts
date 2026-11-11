// Set (n) (OME-906, M10): pre-furnished room presets. A creator picks one when they make a room; each is a plain layout v1
// (ADR 0021, packages/shared/src/layout.ts), so the server stores it like any owner edit and nothing new ships but the
// thumbnails. Rules every preset keeps:
//   - exactly one screen: the TV console (or the Theatre's big screen) in the back corner (0,0), or since wave 2 (ADR 0058) a
//     wall screen or pull-down screen; the picture is page chrome above the room, the screen "throws" it;
//   - exactly 8 seat cells, all facing the TV corner (ne / nw), seat 0 in the front row so the first guest sits up close;
//   - a clear walk line down the middle diagonal, so avatars reach every seat;
//   - nothing on the window / poster / sconce wall segments (5, 6, 8), even wall-backed pieces.
// Thumbnails re-cast the same 3D models at 5/16 scale (a 20×10 tile), like set (h)'s tray thumbnails: not a downscaled
// screenshot, so light, tones and the plum outline are the room's own. No avatars: it's the empty room you'll walk into.
import { FURNITURE, footprintCells, type Furniture, type RoomLayout } from "@omega/shared";
import { PIECES, fitThumb, pieceImage, type Canvas, type PieceDef } from "./furniture";
import { addOutline, box, renderSolids, type Solid, type Vec3 } from "./iso";
import type { RampName } from "./palette";
import { WALL_H, armchairSolids, type RoomFrame, leftWall, planks, rightWall, rug, tvSolids } from "./room";

export interface Preset {
  /** Stable id: what the create form sends (C1 contract, OME-908). `[a-z]`, ≤ 12 chars. */
  readonly id: string;
  readonly name: string;
  /** One line under the thumbnail, ≤ 60 characters. */
  readonly blurb: string;
  readonly layout: RoomLayout;
}

type Kind = Furniture["kind"];
type Facing = Furniture["facing"];
const p = (kind: Kind, col: number, row: number, facing: Facing, variant = 0): Furniture =>
  variant === 0 ? { kind, col, row, facing } : { kind, col, row, facing, variant };
const TV = p("tv", 0, 0, "se");

// Variants: sofa velvet|navy, couch cream|olive, beanbag blush|navy, monstera rust|teal, runner lilac|teal, frame dusk|tide, pouf rust|lilac, neonsign pink|teal, stool wood|teal, piano wood|charcoal.
export const PRESETS: readonly Preset[] = [
  {
    id: "classic",
    name: "Classic",
    blurb: "Armchairs on the big rug, rain on the window.",
    // OME-2480 (OME-2471's judged concept): the screen on the wall, three at-rest loops (lava lamp, rain, clock).
    // DEFAULT_LAYOUT stays the TV-table room (no contract change).
    layout: {
      furniture: [
        p("rug", 1, 1, "se"),
        p("armchair", 1, 5, "ne"), p("armchair", 2, 4, "ne"), p("armchair", 4, 2, "nw"), p("armchair", 5, 1, "nw"),
        p("armchair", 3, 7, "ne"), p("armchair", 4, 6, "ne"), p("armchair", 6, 4, "nw"), p("armchair", 7, 3, "nw"),
        p("wallscreen", 0, 0, "se"), p("lavalamp", 0, 0, "se"), p("window", 3, 0, "sw", 1), p("longclock", 7, 0, "sw"),
        p("lamp", 9, 0, "se"), p("plant", 0, 9, "se"),
        // OME-2497: the bare right wall and front-right edge, off the fixture segments; static pieces, so still three loops.
        p("bookshelf", 1, 0, "sw"), p("monstera", 9, 2, "sw"),
        // OME-2507: the empty front floor below the rug, on the front edge and off the door cell; same sheet, still static.
        p("monstera", 7, 9, "se", 1),
        // OME-2517: the bare left wall (two prints on plain segments 3-4) and the front-left corner by the plant; same sheet, static.
        p("frame", 0, 3, "se"), p("frame", 0, 4, "se", 1), p("arclamp", 0, 7, "se"),
      ],
    },
  },
  {
    id: "cinema",
    name: "Theatre",
    blurb: "Rows on risers before a lit stage and the big screen.",
    layout: {
      furniture: [
        // The theatre set (OME-1639's judged theatre room, OME-1630), its stage risers (wave 26) under the big screen and
        // the curtains on them (OME-2480, OME-2471's judged concept): the carpet and both tiers one cell back, so the
        // back tier still stands a free row behind the front one (OME-2150), aisle lights down the middle. OME-2497: the front
        // tier one cell in toward the aisle, so no row touches a riser, not even corner to corner. The back tier stays: any
        // nearer the camera and a phone's pane crops seat 7.
        p("bigscreen", 0, 0, "se"),
        p("stage", 2, 0, "sw"), p("stage", 0, 2, "se"),
        p("curtain", 1, 0, "sw"), p("curtain", 0, 1, "se"),
        p("carpet", 2, 2, "se"), p("carpet", 4, 2, "se"), p("carpet", 6, 2, "se"), p("carpet", 2, 4, "se"),
        p("carpet", 4, 4, "se"), p("carpet", 6, 4, "se"), p("carpet", 2, 6, "se"), p("carpet", 4, 6, "se"),
        p("aislelight", 6, 6, "nw"), p("aislelight", 7, 7, "nw"), p("aislelight", 8, 8, "nw"),
        p("theatrerow", 3, 5, "ne"), p("theatrerow", 5, 3, "nw"),
        p("theatrerow", 3, 7, "ne", 1), p("theatrerow", 7, 3, "nw", 1),
        p("popcorn", 0, 8, "se"), p("monstera", 9, 0, "sw", 1),
      ],
    },
  },
  {
    id: "living",
    name: "Living room",
    blurb: "Movie night by the fire: couches, wingbacks, beanbags.",
    layout: {
      furniture: [
        // OME-2558 (concept OME-2557, "Movie night by the fire"): everyone on one big rug, facing the hearth wall.
        p("couch", 3, 4, "ne"), p("couch", 5, 7, "ne"),
        p("wingback", 1, 3, "ne"), p("wingback", 6, 3, "ne"),
        p("beanbag", 3, 2, "ne"), p("beanbag", 5, 2, "ne", 1),
        p("rug", 1, 1, "se", 1),
        // The right wall reads shelf | screen over the fire | shelf (no TV table).
        p("fireplace", 3, 0, "sw"), p("wallscreen", 3, 0, "sw"),
        p("bookshelf", 1, 0, "sw"), p("bookshelf", 5, 0, "sw"),
        p("sidetable", 4, 2, "sw"), p("aquarium", 9, 5, "sw"), p("arclamp", 1, 5, "se"),
        p("longclock", 0, 7, "se"), p("frame", 0, 3, "se", 1), p("frame", 0, 4, "se"),
        p("monstera", 9, 0, "sw", 1), p("monstera", 0, 9, "se"),
      ],
    },
  },
  {
    id: "lounge",
    name: "Lounge",
    blurb: "Beanbags and poufs on kilim runners, neon.",
    // Wave 2: a movie corner. The pull-down screen covers left-wall segments 2–4 (5 is a window), the projector stands behind
    // the beanbags, lava lamps in place of the arc lamps, the print moves down to 7.
    layout: {
      furniture: [
        p("beanbag", 2, 4, "ne"), p("beanbag", 4, 2, "nw", 1),
        p("pouf", 2, 6, "ne", 1), p("pouf", 6, 2, "nw"),
        p("beanbag", 5, 7, "ne"), p("beanbag", 7, 5, "nw", 1),
        p("couch", 6, 8, "ne", 1),
        p("runner", 1, 4, "ne"), p("runner", 4, 1, "nw", 1), p("runner", 5, 5, "nw"),
        p("coffeetable", 4, 4, "sw"),
        p("monstera", 0, 7, "se", 1), p("monstera", 7, 0, "sw"), p("monstera", 9, 9, "se", 1),
        p("neonsign", 2, 0, "sw", 1),
        p("projector", 0, 2, "se"), p("tripod", 6, 6, "nw"),
        p("frame", 0, 7, "se"),
        p("lavalamp", 1, 6, "se"), p("lavalamp", 6, 1, "se"),
      ],
    },
  },
  {
    id: "cafe",
    name: "Café",
    blurb: "Rain on the windows, a ticking clock, a mug at every table.",
    layout: {
      furniture: [
        // OME-2509 (concept OME-2508): two regulars on stools at the counter (they look at it, ne, the screen over their shoulder).
        p("stool", 2, 1, "ne"), p("stool", 3, 1, "ne"),
        // Three tables for two in a triangle, a steaming mug on each (static: sidetable/mug isn't ambient), each on a teal runner.
        p("sidetable", 2, 4, "se", 1), p("wingback", 2, 5, "ne"), p("wingback", 3, 4, "nw"),
        p("sidetable", 5, 3, "sw", 1), p("wingback", 5, 4, "ne"), p("wingback", 6, 3, "nw"),
        p("sidetable", 6, 6, "se", 1), p("wingback", 6, 7, "ne"), p("wingback", 7, 6, "nw"),
        p("runner", 1, 4, "ne", 1), p("runner", 5, 2, "nw", 1), p("runner", 5, 6, "ne", 1),
        // The right wall: espresso bar and kitchenette as one counter, the long-case clock (the one new loop), the rain window.
        p("barcounter", 2, 0, "sw", 1), p("barcounter", 4, 0, "sw", 2), p("longclock", 6, 0, "sw"), p("window", 7, 0, "sw", 1),
        p("window", 0, 7, "se", 1), p("wallscreen", 0, 1, "se"),
        p("bookshelf", 0, 3, "se"),
        p("frame", 1, 0, "sw"), p("frame", 0, 4, "se", 1),
        p("arclamp", 1, 7, "se"),
        p("monstera", 0, 9, "se"), p("monstera", 9, 0, "sw", 1), p("monstera", 9, 4, "sw", 1),
      ],
    },
  },
  {
    id: "bar",
    name: "Bar",
    blurb: "Stools at the bar, a velvet booth, a cat by the jukebox.",
    layout: {
      furniture: [
        // OME-2537 (concept OME-2536, "Last orders"): four regulars on stools at one long bar, looking at it and the screen above it.
        p("stool", 2, 1, "ne"), p("stool", 3, 1, "ne", 1), p("stool", 4, 1, "ne"), p("stool", 5, 1, "ne", 1),
        // The velvet booth in front: two sofas facing the bar with a snack table between them.
        p("sofa", 2, 6, "ne"), p("sofa", 5, 6, "ne"),
        // The right wall: two counters end to end under the wall screen (no TV table), a lilac lava lamp at the end of the bar.
        p("barcounter", 2, 0, "sw"), p("barcounter", 4, 0, "sw"), p("wallscreen", 3, 0, "sw"), p("lavalamp", 6, 0, "se"),
        p("sidetable", 4, 6, "se"), p("runner", 3, 3, "ne", 1),
        // The left wall is the music: the piano, the jukebox and the cat between them.
        p("piano", 0, 1, "se", 1), p("speaker", 0, 4, "se", 2), p("cat", 1, 3, "se"),
        p("arcade", 8, 5, "sw"), p("arclamp", 1, 6, "se"),
        p("neonsign", 0, 7, "se"), p("neonsign", 7, 0, "sw", 1),
        p("monstera", 0, 9, "se", 1), p("monstera", 9, 0, "sw"),
      ],
    },
  },
  {
    id: "empty",
    name: "Empty",
    blurb: "Bare boards and beanbags. Furnish it.",
    layout: {
      furniture: [
        TV,
        ...([[1, 5], [2, 4], [4, 2], [5, 1], [3, 7], [4, 6], [6, 4], [7, 3]] as const).map(([c, r], i) =>
          p("beanbag", c, r, c < r ? "ne" : "nw", i % 2),
        ),
      ],
    },
  },
  {
    id: "dank-dungeon",
    name: "Dank Dungeon",
    blurb: "Twin beds, a whirlpool for two, lights down.",
    // A hotel suite after dark (OME-1670, assets/README.md § "Dank Dungeon"); `pairs` turns on /thrust and /bendover (OME-1671).
    // Two rooms (OME-1960, the Designer's grid in assets/README.md § "Partition"): the bedroom behind a wall on row 4, glass
    // where the beds line up, a doorway at (1, 4); the spa in front.
    layout: {
      mood: "night",
      pairs: true,
      shell: "dungeon",
      furniture: [
        TV,
        ...[0, 2, 3, 4, 5, 6, 7, 8, 9].map((c) => p("partition", c, 4, "sw", c >= 3 ? 1 : 0)),
        // Queen beds are 2×2 since OME-2008 (ADR 0057). A far cell (c, r) shows over partition col c − r + 4, so beds on cols 2–5,
        // rows 1–2 fill the glass at cols 4–8 from the south (OME-2023); row 1, not 0, keeps the seats in a phone window (OME-1930).
        p("bed", 2, 2, "nw"), p("bed", 5, 2, "nw"),
        p("desk", 7, 0, "sw"), p("minibar", 9, 0, "sw"), p("wingback", 8, 2, "nw"), p("neonsign", 0, 2, "se"),
        p("whirlpool", 2, 7, "ne"),
        // The grid had (0, 6), but row 6 of the left wall is a fixture segment: a mirror can't hang there.
        p("washbasin", 0, 7, "se"), p("mirror", 0, 7, "se"),
        // By the glass, looking in at the beds (OME-2039); the table at its side.
        p("wingback", 5, 5, "ne"), p("coffeetable", 6, 5, "sw"),
        // The plant stays off DOOR_CELL (9, 9), where people walk in (OME-2039).
        p("arclamp", 1, 9, "se"), p("monstera", 9, 8, "sw", 1),
      ],
    },
  },
  {
    id: "penthouse",
    name: "Penthouse",
    blurb: "A lounge with a rooftop terrace behind the glass.",
    // Wave 2 swap room (OME-2071, assets/README.md § "Wave 2"), on OME-1959's grid: the partition on row 4, a doorway at (1, 4).
    layout: {
      shell: "penthouse",
      furniture: [
        // Terrace (rows 0–3): loungers, string lights on the open-air rail, plants. The loungers leave col 7–9 walkable.
        p("lounger", 6, 0, "nw"), p("lounger", 8, 0, "nw"),
        p("monstera", 0, 0, "se"), p("monstera", 9, 3, "sw", 1),
        p("garland", 3, 0, "sw"), p("garland", 7, 0, "sw"), p("garland", 0, 2, "se"),
        ...[0, 2, 3, 4, 5, 6, 7, 8, 9].map((c) => p("partition", c, 4, "sw", c === 0 ? 2 : 3)),
        // Lounge (rows 5–9): the sofa and couch facing the wall screen, the aquarium, a bar fridge under the neon.
        p("aquarium", 0, 5, "se"), p("wallscreen", 0, 7, "se"), p("minibar", 0, 9, "se", 1), p("neonsign", 0, 9, "se"),
        p("sofa", 4, 6, "nw"), p("couch", 6, 6, "nw"), p("coffeetable", 2, 7, "sw"), p("arclamp", 8, 8, "se"), p("monstera", 9, 8, "sw", 1),
        // The Designer's grid had 6 seats: a third lounger and a pouf make 8.
        p("lounger", 3, 1, "nw"), p("pouf", 8, 7, "nw", 1),
      ],
    },
  },
  {
    id: "studio",
    name: "Studio flat",
    blurb: "Kitchen and couch in front, a sleeping nook behind.",
    layout: {
      shell: "studio",
      furniture: [
        // Nook (rows 0–3): the queen bed, a steaming mug, a rainy window, the cat, a bookcase.
        p("bed", 4, 1, "nw"), p("sidetable", 6, 1, "sw", 1), p("bookshelf", 0, 1, "se"), p("window", 7, 0, "sw", 1), p("cat", 2, 2, "se"), p("arclamp", 8, 1, "sw"),
        ...[0, 2, 3, 4, 5, 6, 7, 8, 9].map((c) => p("partition", c, 4, "sw", c >= 3 && c <= 7 ? 1 : 0)),
        // Kitchen-living room (rows 5–9): the kitchenette, a breakfast table with stools, the couch facing the wall screen.
        p("barcounter", 0, 5, "se", 2), p("minibar", 0, 7, "se", 1), p("sidetable", 3, 6, "se"), p("stool", 3, 7, "ne", 1), p("stool", 4, 6, "nw"),
        p("couch", 5, 7, "nw", 1), p("wallscreen", 0, 8, "se"), p("beanbag", 7, 8, "nw", 1), p("monstera", 9, 6, "sw"),
        // 7 seats on the Designer's grid; a pouf makes 8.
        p("pouf", 7, 6, "nw", 1),
      ],
    },
  },
  {
    id: "stage-door",
    name: "Stage Door",
    blurb: "A club stage in front, the green room behind the wings.",
    // Wave 26 (OME-2441, the judged set OME-2440, assets/src/wave26.ts): the partition on column 4 facing se, velvet at rows
    // 0–1 and 8–9, open wings at 2–6, the stage door (the gap) at (4, 7). The green room's seats face the wings.
    layout: {
      shell: "stage-door",
      furniture: [
        ...[0, 1, 8, 9].map((r) => p("partition", 4, r, "se", 4)),
        ...[2, 3, 4, 5, 6].map((r) => p("partition", 4, r, "se", 5)),
        // The stage, cols 5–9.
        p("stage", 6, 0, "sw"), p("projector", 6, 0, "sw"), p("curtain", 5, 0, "sw"), p("curtain", 9, 0, "sw"), p("tripod", 7, 8, "ne"),
        p("beanbag", 6, 4, "ne"), p("beanbag", 8, 4, "ne", 1), p("sidetable", 7, 5, "se"), p("stool", 6, 6, "ne", 1), p("stool", 8, 6, "ne", 1),
        p("arclamp", 9, 6, "se"), p("monstera", 5, 9, "se"),
        // The green room, cols 0–3.
        p("vanity", 0, 8, "se"), p("vanity", 0, 9, "se"), p("rack", 1, 6, "sw"), p("couch", 1, 3, "se", 1), p("wingback", 2, 5, "se"),
        p("pouf", 3, 2, "se", 1), p("minibar", 1, 0, "sw", 1), p("neonsign", 2, 0, "sw"), p("lavalamp", 3, 0, "se"), p("monstera", 1, 9, "se", 1),
      ],
    },
  },
  {
    id: "reef",
    name: "Reef Tunnel",
    blurb: "A reef bar, and a tunnel through the tanks to the deep.",
    // Wave 26 (OME-2441): the partition on row 4, smoked panel at cols 0 and 9, tanks between, the walkable tunnel at (3, 4) the
    // only way through. The deep's seats face the tanks.
    layout: {
      shell: "reef",
      furniture: [
        p("partition", 0, 4, "sw", 2),
        ...[1, 2, 4, 5, 6, 7, 8].map((c) => p("partition", c, 4, "sw", 6)),
        p("partition", 3, 4, "sw", 7),
        p("partition", 9, 4, "sw", 2),
        // The reef bar, rows 5–9.
        p("barcounter", 0, 5, "se"), p("stool", 1, 5, "nw", 1), p("stool", 1, 6, "nw", 1), p("wallscreen", 0, 7, "se"), p("couch", 4, 7, "nw"),
        p("coffeetable", 2, 8, "se"), p("neonsign", 0, 9, "se", 1), p("lavalamp", 8, 6, "se", 1), p("monstera", 9, 8, "se", 1),
        // The deep, rows 0–3.
        p("hammock", 5, 1, "sw"), p("beanbag", 2, 2, "sw", 1), p("beanbag", 8, 2, "sw", 1),
        p("lavalamp", 0, 0, "se", 1), p("lavalamp", 9, 0, "se", 1), p("monstera", 0, 2, "se", 1),
      ],
    },
  },
];

// ------------------------------------------------------------------ thumbnails

/** World → thumbnail scale: a 64×32 tile becomes 20×10, so every cell centre lands on a whole pixel. */
export const THUMB_SCALE = 5 / 16;
export const THUMB = { w: 212, h: 176 } as const;
/** Cell (0,0) centre in the thumbnail. */
const OX = 106, OY = 77;
const cellXY = (c: number, r: number): { x: number; y: number } => ({ x: OX + (c - r) * 10, y: OY + (c + r) * 5 });

/** Move a solid by (du, dv) world units: planes, ellipsoid centre and the paint lookup all follow. */
function shift(s: Solid, du: number, dv: number): Solid {
  const out: Solid = { ...s, planes: s.planes.map((pl) => ({ n: pl.n, d: pl.d + pl.n.u * du + pl.n.v * dv })) };
  if (s.quad) out.quad = { c: { u: s.quad.c.u + du, v: s.quad.c.v + dv, z: s.quad.c.z }, r: s.quad.r };
  const paint = s.paint;
  if (paint) out.paint = (q: Vec3, f) => paint({ u: q.u - du, v: q.v - dv, z: q.z }, f);
  return out;
}

const RUG_SIZE = 7;
/** The room atlas rug's 9-slice part for a cell, or null off the rug. */
function rugPart(layout: RoomLayout, c: number, r: number): Parameters<typeof rug>[0] | null {
  const piece = layout.furniture.find((f) => f.kind === "rug");
  if (!piece) return null;
  const c0 = piece.col, r0 = piece.row, c1 = c0 + RUG_SIZE - 1, r1 = r0 + RUG_SIZE - 1;
  if (c < c0 || c > c1 || r < r0 || r > r1) return null;
  const nw = c === c0, se = c === c1, ne = r === r0, sw = r === r1;
  return nw && ne ? "n" : se && ne ? "e" : se && sw ? "s" : nw && sw ? "w" : nw ? "nw" : se ? "se" : ne ? "ne" : sw ? "sw" : "c";
}

/** Floor (planks, the big rug where there is one) as a slab, with both walls, the corner block and the open wall ends. */
function shell(layout: RoomLayout): Solid[] {
  const N = 10, E = N * 16 - 8, T = 4;
  const floor = box(-8, E, -8, E, -6, 0, "wood", {
    tones: { sw: 1, se: 2 },
    paint: (q, f) => {
      if (f !== "top") return null;
      const c = Math.min(N - 1, Math.floor((q.u + 8) / 16)), r = Math.min(N - 1, Math.floor((q.v + 8) / 16));
      const lu = q.u - c * 16, lv = q.v - r * 16;
      const part = rugPart(layout, c, r);
      return part ? rug(part, 0)(lu, lv) : planks((c * 3 + r) % 2)(lu, lv);
    },
  });
  const L = ["plain", "plain", "plain", "plain", "plain", "window0", "window1", "plain", "sconce", "plain"] as const;
  const R = ["plain", "plain", "plain", "plain", "plain", "poster0", "poster1", "plain", "sconce", "plain"] as const;
  const walls: Solid[] = [];
  for (let i = 0; i < N; i++) {
    walls.push(shift(leftWall(L[i] ?? "plain"), 0, i * 16), shift(rightWall(R[i] ?? "plain"), i * 16, 0));
  }
  const cap = (_q: Vec3, f: string): readonly [RampName, 0 | 1 | 2] | null => (f === "top" ? ["wall", 0] : null);
  walls.push(box(-8 - T, -8, -8 - T, -8, 0, WALL_H, "wall", { paint: cap }));
  walls.push(box(-8 - T, -8, E - 1, E, 0, WALL_H, "wall", { paint: (q, f) => (f === "top" ? ["wall", 0] : ["wall", 1]) }));
  walls.push(box(E - 1, E, -8 - T, -8, 0, WALL_H, "wall", { paint: (q, f) => (f === "top" ? ["wall", 0] : ["wall", 2]) }));
  return [floor, ...walls];
}

/** The room atlas's two pixel-grid props (floor lamp, potted plant), rebuilt as tiny solids: grids don't re-cast. */
function propSolids(kind: "lamp" | "plant"): Solid[] {
  const cyl = (r: number, z0: number, z1: number, ramp: RampName, extra: Partial<Solid> = {}): Solid => ({
    ...box(-r, r, -r, r, z0, z1, ramp, extra),
    quad: { c: { u: 0, v: 0, z: 0 }, r: { u: r, v: r, z: Infinity } },
  });
  if (kind === "plant") {
    const leaves: Solid = { ...box(-8, 8, -8, 8, 8, 30, "olive"), quad: { c: { u: 0, v: 0, z: 18 }, r: { u: 7, v: 7, z: 11 } } };
    return [cyl(4.5, 0, 9, "rust"), leaves];
  }
  return [cyl(4, 0, 2, "charcoal"), box(-0.8, 0.8, -0.8, 0.8, 2, 46, "charcoal"), cyl(5.5, 46, 58, "cream", { tones: { top: 0, sw: 0, se: 1 } })];
}

const CV: Canvas = { w: 160, h: 160, ax: 80, ay: 120 };
const defOf = (kind: Kind): PieceDef => {
  const id = kind === "runner" ? "rug" : kind;
  const d = PIECES.find((x) => x.id === id);
  if (!d) throw new Error(`no catalogue piece ${id}`);
  return d;
};

/** Renders a piece the catalogue doesn't hold (wave 2's kinds and colours, `wave2Thumb`), or undefined. Injected, as
 *  wave2.ts reads PRESETS. */
export type ExtraThumb = (f: Furniture, scale: number, cv: Canvas) => Uint8Array | undefined;

/** One piece at thumbnail scale on CV (origin = its anchor cell centre). */
function pieceThumb(f: Furniture, extra?: ExtraThumb): Uint8Array {
  const own = extra?.(f, THUMB_SCALE, CV);
  if (own) return own;
  const solids = (list: readonly Solid[]): Uint8Array => renderSolids(list, CV.w, CV.h, CV.ax, CV.ay, "all", THUMB_SCALE).img;
  if (f.kind === "tv") return solids(tvSolids());
  if (f.kind === "armchair") {
    const a = armchairSolids(f.facing);
    return solids([...a.back, ...a.front]);
  }
  if (f.kind === "lamp" || f.kind === "plant") return solids(propSolids(f.kind));
  if (f.kind === "rug") throw new Error("the big rug is painted with the floor");
  const def = defOf(f.kind);
  return pieceImage(def, def.colours[f.variant ?? 0] ?? def.colours[0] ?? "", f.facing, THUMB_SCALE, CV);
}

/** Tray thumbnails (ui/edit.png) for the room atlas pieces, which the catalogue's `buildThumbs` doesn't cover (OME-1847):
 *  the same solids as the preset thumbnails, fitted like the catalogue's. The big rug shows a 3×3 corner of itself. */
export function buildRoomThumbs(): RoomFrame[] {
  const cv: Canvas = { w: 240, h: 200, ax: 110, ay: 150 };
  const at = (list: readonly Solid[]) => (s: number): Uint8Array => renderSolids(list, cv.w, cv.h, cv.ax, cv.ay, "all", s).img;
  const chair = armchairSolids("se");
  const part = (c: number, r: number): Parameters<typeof rug>[0] => {
    const nw = c === 0, se = c === 2, ne = r === 0, sw = r === 2;
    return nw && ne ? "n" : se && ne ? "e" : se && sw ? "s" : nw && sw ? "w" : nw ? "nw" : se ? "se" : ne ? "ne" : sw ? "sw" : "c";
  };
  const rugSlab = box(-8, 40, -8, 40, -2, 0, "navy", {
    paint: (q, f) => {
      const c = Math.min(2, Math.floor((q.u + 8) / 16)), r = Math.min(2, Math.floor((q.v + 8) / 16));
      return f === "top" ? rug(part(c, r), 0)(q.u - c * 16, q.v - r * 16) : ["navy", 2];
    },
  });
  return [
    fitThumb("thumb/armchair/velvet", cv, at([...chair.back, ...chair.front])),
    fitThumb("thumb/tv/charcoal", cv, at(tvSolids())),
    fitThumb("thumb/lamp/cream", cv, at(propSolids("lamp"))),
    fitThumb("thumb/plant/rust", cv, at(propSolids("plant"))),
    fitThumb("thumb/rug/navy", cv, at([rugSlab])),
  ];
}

function blitCell(dst: Uint8Array, src: Uint8Array, c: number, r: number): void {
  const { x, y } = cellXY(c, r);
  for (let yy = 0; yy < CV.h; yy++) {
    for (let xx = 0; xx < CV.w; xx++) {
      const v = src[yy * CV.w + xx] ?? 0;
      if (v === 0) continue;
      const px = x - CV.ax + xx, py = y - CV.ay + yy;
      if (px <= 0 || py <= 0 || px >= THUMB.w - 1 || py >= THUMB.h - 1) throw new Error(`preset thumbnail: piece at ${String(c)},${String(r)} touches the edge`);
      dst[py * THUMB.w + px] = v;
    }
  }
}

/** Painter's order as in the room (assets/README.md): floor pieces, then wall pieces, then objects by sort point y, then x. */
export function presetThumb(layout: RoomLayout, extra?: ExtraThumb): Uint8Array {
  const img = renderSolids(shell(layout), THUMB.w, THUMB.h, OX, OY, "all", THUMB_SCALE).img;
  const layer = (f: Furniture): string => FURNITURE[f.kind].layer;
  for (const f of layout.furniture.filter((x) => layer(x) === "floor" && x.kind !== "rug")) blitCell(img, pieceThumb(f, extra), f.col, f.row);
  for (const f of layout.furniture.filter((x) => layer(x) === "wall")) blitCell(img, pieceThumb(f, extra), f.col, f.row);
  const sortPoint = (f: Furniture): { x: number; y: number } => {
    const cells = footprintCells(f);
    const mc = cells.reduce((a, [c]) => a + c, 0) / cells.length, mr = cells.reduce((a, [, r]) => a + r, 0) / cells.length;
    return { x: mc - mr, y: mc + mr };
  };
  const objects = layout.furniture.filter((x) => layer(x) === "object").map((f) => ({ f, s: sortPoint(f) }));
  objects.sort((a, b) => a.s.y - b.s.y || a.s.x - b.s.x);
  for (const { f } of objects) blitCell(img, pieceThumb(f, extra), f.col, f.row);
  // Pieces carry their own outline; re-run it so a piece's outline over the floor stays one px and nothing is left open.
  addOutline(img, THUMB.w, THUMB.h);
  return img;
}
