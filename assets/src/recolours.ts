// Furniture recolours (OME-1462): 2 extra colours for sofa, rug, beanbag, pouf, stool and runner (and OME-1500: frame, garland), by the shirt tints' technique.
// Runtime PLTE swap, not a bake: every sheet carries the full PALETTE, so swapping a piece's fabric ramp slots in a copy of its
// sheet (and of ui/edit.png for the tray thumbnail) gives the new colour with no new frames and no sheet bytes. Baking the same
// 12 colours costs +11 101 B of PNG and +639 B of JSON gz (measured, see README "Furniture recolours"); the table is ~0.5 KB gz.
// Targets are shared-palette ramps only, so a swapped frame is index-for-index the frame a direct render in that ramp would give.
import { PIECES, pieceFrames } from "./furniture";
import { PALETTE, RAMPS, colorIndex, type RampName, type Tone } from "./palette";
import type { RGBA } from "./png";
import { RUG_PARTS, buildRoomFrames, type RoomFrame } from "./room";
import { applyRemap } from "./tints";

const TONES: readonly Tone[] = [0, 1, 2];

export interface Recolour {
  /** Sheet holding the source frames, relative to assets/. */
  sheet: string;
  /** Every frame whose key starts with this is the source colour's (and only those take the swap). */
  frames: string;
  /** Tray thumbnail in ui/edit.png, swapped the same way (the room rug has none). */
  thumb?: string;
  /** Shipped colour's name when the frame keys don't carry one (room.png pieces). */
  source?: string;
  /** Variants the piece already ships; the new ones are numbered from here. */
  existing: number;
  /** Ramps swapped, in the source colour. */
  from: readonly RampName[];
  /** New colours: `to[i]` replaces `from[i]`; `shade`, if set, gives `to[0]`'s shade tone instead. `id` is also the `swatch/<id>` chip in ui/edit.png. */
  variants: readonly { id: string; to: readonly RampName[]; shade?: RampName }[];
}

/** Keyed by the `FURNITURE` kind in packages/shared: `rug` is the room's 7×7 rug (room.png), `runner` the kilim runner (atlas id `rug`). */
export const RECOLOURS: Readonly<Record<string, Recolour>> = {
  sofa: { sheet: "furniture/furniture.png", frames: "furniture/sofa/velvet/", thumb: "thumb/sofa/velvet", existing: 2, from: ["velvet"], variants: [{ id: "teal", to: ["teal"] }, { id: "ginger", to: ["ginger"] }] },
  rug: { sheet: "room/room.png", frames: "rug/", source: "navy", existing: 1, from: ["navy", "mustard"], variants: [{ id: "rust", to: ["rust", "mustard"] }, { id: "teal", to: ["teal", "cream"] }] },
  beanbag: { sheet: "furniture/furniture.png", frames: "furniture/beanbag/blush/", thumb: "thumb/beanbag/blush", existing: 2, from: ["blush"], variants: [{ id: "mustard", to: ["mustard"] }, { id: "lilac", to: ["lilac"] }] },
  pouf: { sheet: "furniture/furniture-v2.png", frames: "furniture/pouf/rust/", thumb: "thumb/pouf/rust", existing: 2, from: ["rust"], variants: [{ id: "teal", to: ["teal"] }, { id: "mustard", to: ["mustard"] }] },
  stool: { sheet: "furniture/furniture-v4.png", frames: "furniture/stool/teal/", thumb: "thumb/stool/teal", existing: 2, from: ["teal"], variants: [{ id: "lilac", to: ["lilac"] }, { id: "mustard", to: ["mustard"] }] },
  runner: { sheet: "furniture/furniture.png", frames: "furniture/rug/lilac/", thumb: "thumb/rug/lilac", existing: 2, from: ["lilac", "pink"], variants: [{ id: "rust", to: ["rust", "teal"] }, { id: "mustard", to: ["mustard", "navy"] }] },
  // OME-1500, wall decor. The dusk print's sky, far and near ridges and sun (the wood trim and mat stay); the warm string's two bulbs.
  frame: { sheet: "furniture/furniture.png", frames: "furniture/frame/dusk/", thumb: "thumb/frame/dusk", existing: 2, from: ["pink", "lilac", "navy", "mustard"], variants: [{ id: "meadow", to: ["glow", "teal", "olive", "mustard"] }, { id: "sunset", to: ["ginger", "rust", "velvet", "cream"] }] },
  garland: { sheet: "furniture/furniture-v2.png", frames: "furniture/garland/warm/", thumb: "thumb/garland/warm", existing: 2, from: ["glow", "mustard"], variants: [{ id: "frost", to: ["teal", "glow"] }, { id: "peach", to: ["blush", "mustard"] }] },
  // OME-1688, lamps, plants and shelves. Room lamp: its shade. Room plant, monstera: the pot. Arc lamp: the brass, then the shade.
  // Bookcase: the case, with its cream and teal spines (and globe) swapped out of the way; the cream case keeps the wood shade so it
  // reads on the lightest floor (OME-1707). Wall shelf: the plank, then the pot band.
  lamp: { sheet: "room/room.png", frames: "lamp/", source: "cream", existing: 1, from: ["cream"], variants: [{ id: "teal", to: ["teal"] }, { id: "lilac", to: ["lilac"] }] },
  plant: { sheet: "room/room.png", frames: "plant/", source: "rust", existing: 1, from: ["rust"], variants: [{ id: "teal", to: ["teal"] }, { id: "mustard", to: ["mustard"] }] },
  arclamp: { sheet: "furniture/furniture.png", frames: "furniture/arclamp/brass/", thumb: "thumb/arclamp/brass", existing: 1, from: ["mustard", "cream"], variants: [{ id: "lilac", to: ["lilac", "cream"] }, { id: "teal", to: ["mustard", "teal"] }] },
  monstera: { sheet: "furniture/furniture.png", frames: "furniture/monstera/rust/", thumb: "thumb/monstera/rust", existing: 2, from: ["rust"], variants: [{ id: "mustard", to: ["mustard"] }, { id: "lilac", to: ["lilac"] }] },
  bookshelf: { sheet: "furniture/furniture.png", frames: "furniture/bookshelf/wood/", thumb: "thumb/bookshelf/wood", existing: 1, from: ["wood", "cream", "teal"], variants: [{ id: "cream", to: ["cream", "wood", "teal"], shade: "wood" }, { id: "teal", to: ["teal", "cream", "navy"] }] },
  wallshelf: { sheet: "furniture/furniture-v2.png", frames: "furniture/wallshelf/wood/", thumb: "thumb/wallshelf/wood", existing: 1, from: ["wood", "teal"], variants: [{ id: "cream", to: ["cream", "teal"] }, { id: "teal", to: ["teal", "rust"] }] },
};

/** Wall-mounted kinds: they get their own contact sheet, on the wall and under the room moods, not on the floor. */
export const WALL_KINDS: ReadonlySet<string> = new Set(["frame", "garland", "wallshelf"]);

/** Index remap for previews and tests: every tone of `from[i]` → the same tone of `to[i]`. */
export function recolourRemap(r: Recolour, variant: number): Map<number, number> {
  const v = r.variants[variant];
  if (v?.to.length !== r.from.length) throw new Error(`no recolour ${String(variant)}`);
  return new Map(r.from.flatMap((f, i) => TONES.map((t) => [colorIndex(f, t), colorIndex(i === 0 && t === 2 && v.shade ? v.shade : (v.to[i] ?? f), t)] as [number, number])));
}

/** furniture/recolours.json: what the client needs for the PLTE swap. */
export function recoloursTable(): object {
  return {
    license: "CC-BY-SA-4.0",
    method:
      "runtime PLTE swap: in a copy of `sheet` replace PLTE entry slots[i] with colors[i] and use that copy only for the frames whose key starts with `frames` (the source colour's); do the same in a copy of ui/edit.png for `thumb`. Layout variant `variant` draws those frames; its tray chip is swatch/<id>",
    kinds: Object.fromEntries(
      Object.entries(RECOLOURS).map(([kind, r]) => [
        kind,
        {
          sheet: r.sheet,
          frames: r.frames,
          ...(r.thumb ? { thumb: r.thumb } : {}),
          slots: r.from.flatMap((f) => TONES.map((t) => colorIndex(f, t))),
          variants: r.variants.map((v, i) => ({ variant: r.existing + i, id: v.id, colors: v.to.flatMap((t, i) => RAMPS[t].map((h, k) => (i === 0 && k === 2 && v.shade ? RAMPS[v.shade][2] : h))) })),
        },
      ]),
    ),
  };
}

interface Img { w: number; h: number; ax: number; ay: number; img: Uint8Array }

/** Every variant of every kind, shipped ones first: one image per facing (back and front merged; the rug as a 4×4 patch). */
export function recolourCells(): { kind: string; variant: string; images: Img[] }[] {
  const frames = sourcePieceFrames();
  const room = buildRoomFrames();
  const out: { kind: string; variant: string; images: Img[] }[] = [];
  for (const [kind, r] of Object.entries(RECOLOURS)) {
    const shipped: { variant: string; images: Img[] }[] = [];
    if (kind === "rug") shipped.push({ variant: r.source ?? "", images: [rugPatch(room)] });
    else if (r.sheet === "room/room.png") shipped.push({ variant: r.source ?? "", images: room.filter((f) => f.key.startsWith(r.frames)) });
    else {
      const id = r.frames.split("/")[1] ?? "";
      const colours = [...new Set(frames.filter((f) => f.key.startsWith(`furniture/${id}/`)).map((f) => f.key.split("/")[2] ?? ""))];
      for (const c of colours) shipped.push({ variant: c, images: facings(frames.filter((f) => f.key.startsWith(`furniture/${id}/${c}/`) && !/\/(use|open)\//.test(f.key))) });
    }
    const source = shipped.find((s) => r.frames.endsWith(`/${s.variant}/`)) ?? shipped[0];
    if (!source) throw new Error(`${kind}: no source frames`);
    out.push(...shipped.map((s) => ({ kind, ...s })));
    r.variants.forEach((v, i) => {
      const remap = recolourRemap(r, i);
      out.push({ kind, variant: v.id, images: source.images.map((m) => ({ ...m, img: applyRemap(m.img, remap) })) });
    });
  }
  return out;
}

/** Every shipped frame of the furniture kinds in RECOLOURS (all their colours): a full catalogue build takes minutes. */
export function sourcePieceFrames(): RoomFrame[] {
  const ids = new Set(Object.values(RECOLOURS).flatMap((r) => (r.frames.startsWith("furniture/") ? [r.frames.split("/")[1] ?? ""] : [])));
  return PIECES.filter((p) => ids.has(p.id)).flatMap((p) => p.colours.flatMap((c) => p.dirs.flatMap((d) => pieceFrames(p, c, d))));
}

/** One image per facing: `back` with `front` over it (they share a rect). */
function facings(fs: readonly { key: string; w: number; h: number; ax: number; ay: number; img: Uint8Array }[]): Img[] {
  const byDir = new Map<string, Img>();
  for (const f of fs) {
    const dir = f.key.split("/")[3] ?? "";
    const prev = byDir.get(dir);
    if (!prev) byDir.set(dir, { ...f, img: f.img.slice() });
    else for (let i = 0; i < f.img.length; i++) if ((f.img[i] ?? 0) !== 0) prev.img[i] = f.img[i] ?? 0;
  }
  return [...byDir.values()];
}

/** The room rug's 9-slice as a 4×4 patch (corners, two of each edge, a 2×2 field). */
function rugPatch(room: readonly { key: string; img: Uint8Array }[]): Img {
  const N = 4, W = 32 * 2 * N, H = 16 * 2 * N;
  const img = new Uint8Array(W * H);
  for (let r = 0; r < N; r++)
    for (let c = 0; c < N; c++) {
      const nw = c === 0, se = c === N - 1, ne = r === 0, sw = r === N - 1;
      const part = nw && ne ? "n" : se && ne ? "e" : se && sw ? "s" : nw && sw ? "w" : nw ? "nw" : se ? "se" : ne ? "ne" : sw ? "sw" : "c";
      if (!RUG_PARTS.includes(part)) throw new Error(part);
      const tile = room.find((f) => f.key === `rug/${part}`);
      if (!tile) throw new Error(`no rug/${part}`);
      const ox = (c - r) * 32 + (N - 1) * 32, oy = (c + r) * 16;
      for (let y = 0; y < 32; y++) for (let x = 0; x < 64; x++) { const v = tile.img[y * 64 + x] ?? 0; if (v !== 0) img[(oy + y) * W + ox + x] = v; }
    }
  return { w: W, h: H, ax: W / 2, ay: H / 2, img };
}

/** One panel of the contact sheets: one row per kind, one cell per variant (shipped, then the 2 new), every facing in a cell,
 *  on a transparent ground (index 0). A thin cream rule marks where the new variants start. */
function recolourPanel(kinds: readonly string[]): { w: number; h: number; img: Uint8Array } {
  const cells = recolourCells().filter((c) => kinds.includes(c.kind));
  const GAP = 4;
  const cellW = (c: (typeof cells)[number]): number => c.images.reduce((s, m) => s + m.w + GAP, GAP);
  const colW = Array.from({ length: 4 }, (_, i) => Math.max(...kinds.map((k) => { const c = cells.filter((x) => x.kind === k)[i]; return c ? cellW(c) : 0; })));
  const rowH = kinds.map((k) => Math.max(...cells.filter((c) => c.kind === k).flatMap((c) => c.images.map((m) => m.h))) + 2 * GAP);
  const w = colW.reduce((a, b) => a + b, 0), h = rowH.reduce((a, b) => a + b, 0);
  const RULE = colorIndex("cream", 0);
  const img = new Uint8Array(w * h);
  let y0 = 0;
  kinds.forEach((k, ri) => {
    const row = cells.filter((c) => c.kind === k);
    const shipped = RECOLOURS[k]?.existing ?? 0;
    let x0 = 0;
    row.forEach((c, ci) => {
      if (ci === shipped) for (let y = y0 + GAP; y < y0 + (rowH[ri] ?? 0) - GAP; y++) img[y * w + x0 - 1] = RULE;
      let x = x0 + GAP;
      for (const m of c.images) {
        const oy = y0 + (rowH[ri] ?? 0) - GAP - m.h;
        for (let yy = 0; yy < m.h; yy++) for (let xx = 0; xx < m.w; xx++) { const v = m.img[yy * m.w + xx] ?? 0; if (v !== 0) img[(oy + yy) * w + x + xx] = v; }
        x += m.w + GAP;
      }
      x0 += colW[ci] ?? 0;
    });
    y0 += rowH[ri] ?? 0;
  });
  return { w, h, img };
}

/** Contact sheet of the floor kinds: the room floor panel on top, the dark site bg (#1d1a2b) panel below. */
export function recolourSheet(): { w: number; h: number; img: Uint8Array; palette: RGBA[] } {
  const p = recolourPanel(Object.keys(RECOLOURS).filter((k) => !WALL_KINDS.has(k)));
  const PAD = 8;
  const w = p.w, h = p.h * 2 + PAD;
  const palette = [...PALETTE, { r: 0x1d, g: 0x1a, b: 0x2b, a: 255 }];
  const DARK = palette.length - 1, LIGHT = colorIndex("floor", 1);
  const img = new Uint8Array(w * h).fill(colorIndex("cream", 1));
  for (const [py, bg] of [[0, LIGHT], [p.h + PAD, DARK]] as const)
    for (let i = 0; i < p.w * p.h; i++) { const v = p.img[i] ?? 0; img[py * w + i] = v === 0 ? bg : v; }
  return { w, h, img, palette };
}

/** Room moods as mocked here (OME-1500; the real ones are OME-1502's): a flat rgba over the whole room, like the cinema dim. */
export const MOODS: readonly { id: string; rgb: readonly [number, number, number]; a: number }[] = [
  { id: "none", rgb: [0, 0, 0], a: 0 },
  { id: "warm", rgb: [255, 140, 50], a: 0.18 },
  { id: "cool", rgb: [60, 120, 255], a: 0.18 },
  { id: "night", rgb: [14, 12, 46], a: 0.5 },
];
export const SITE_BG = "#1d1a2b";

/** Contact sheet of the wall kinds: a wall panel (wall base, flat) under each mood, top to bottom none, warm, cool, night, then
 *  the dark site bg (the tray) with no mood. Truecolour, so the overlays are real blends; re-indexed for the PNG. */
export function wallRecolourSheet(): { w: number; h: number; img: Uint8Array; palette: RGBA[] } {
  const p = recolourPanel([...WALL_KINDS]);
  const PAD = 6;
  const panels = [...MOODS.map((m) => ({ bg: RAMPS.wall[1], mood: m })), { bg: SITE_BG, mood: MOODS[0] }];
  const w = p.w, h = panels.length * (p.h + PAD) - PAD;
  const hex = (s: string): [number, number, number] => { const n = Number.parseInt(s.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const palette: RGBA[] = [];
  const slot = new Map<number, number>();
  const index = ([r, g, b]: readonly number[]): number => {
    const key = ((r ?? 0) << 16) | ((g ?? 0) << 8) | (b ?? 0);
    let i = slot.get(key);
    if (i === undefined) { i = palette.length; slot.set(key, i); palette.push({ r: r ?? 0, g: g ?? 0, b: b ?? 0, a: 255 }); }
    return i;
  };
  const img = new Uint8Array(w * h).fill(index(hex(RAMPS.cream[1])));
  panels.forEach(({ bg, mood }, pi) => {
    const a = mood?.a ?? 0, tint = mood?.rgb ?? [0, 0, 0];
    for (let i = 0; i < p.w * p.h; i++) {
      const v = p.img[i] ?? 0, c = PALETTE[v];
      const rgb = v === 0 || !c ? hex(bg) : [c.r, c.g, c.b];
      img[pi * (p.h + PAD) * w + i] = index(rgb.map((x, k) => Math.round(x * (1 - a) + (tint[k] ?? 0) * a)));
    }
  });
  if (palette.length > 256) throw new Error(`wall sheet: ${String(palette.length)} colours`);
  return { w, h, img, palette };
}
