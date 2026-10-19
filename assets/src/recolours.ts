// Furniture recolours (OME-1462): 2 extra colours for sofa, rug, beanbag, pouf, stool and runner, by the shirt tints' technique.
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
  /** Variants the piece already ships; the new ones are numbered from here. */
  existing: number;
  /** Ramps swapped, in the source colour. */
  from: readonly RampName[];
  /** New colours: `to[i]` replaces `from[i]`. `id` is also the `swatch/<id>` chip in ui/edit.png. */
  variants: readonly { id: string; to: readonly RampName[] }[];
}

/** Keyed by the `FURNITURE` kind in packages/shared: `rug` is the room's 7×7 rug (room.png), `runner` the kilim runner (atlas id `rug`). */
export const RECOLOURS: Readonly<Record<string, Recolour>> = {
  sofa: { sheet: "furniture/furniture.png", frames: "furniture/sofa/velvet/", thumb: "thumb/sofa/velvet", existing: 2, from: ["velvet"], variants: [{ id: "teal", to: ["teal"] }, { id: "ginger", to: ["ginger"] }] },
  rug: { sheet: "room/room.png", frames: "rug/", existing: 1, from: ["navy", "mustard"], variants: [{ id: "rust", to: ["rust", "mustard"] }, { id: "teal", to: ["teal", "cream"] }] },
  beanbag: { sheet: "furniture/furniture.png", frames: "furniture/beanbag/blush/", thumb: "thumb/beanbag/blush", existing: 2, from: ["blush"], variants: [{ id: "mustard", to: ["mustard"] }, { id: "lilac", to: ["lilac"] }] },
  pouf: { sheet: "furniture/furniture-v2.png", frames: "furniture/pouf/rust/", thumb: "thumb/pouf/rust", existing: 2, from: ["rust"], variants: [{ id: "teal", to: ["teal"] }, { id: "mustard", to: ["mustard"] }] },
  stool: { sheet: "furniture/furniture-v4.png", frames: "furniture/stool/teal/", thumb: "thumb/stool/teal", existing: 2, from: ["teal"], variants: [{ id: "lilac", to: ["lilac"] }, { id: "mustard", to: ["mustard"] }] },
  runner: { sheet: "furniture/furniture.png", frames: "furniture/rug/lilac/", thumb: "thumb/rug/lilac", existing: 2, from: ["lilac", "pink"], variants: [{ id: "rust", to: ["rust", "teal"] }, { id: "mustard", to: ["mustard", "navy"] }] },
};

/** Index remap for previews and tests: every tone of `from[i]` → the same tone of `to[i]`. */
export function recolourRemap(r: Recolour, variant: number): Map<number, number> {
  const v = r.variants[variant];
  if (v?.to.length !== r.from.length) throw new Error(`no recolour ${String(variant)}`);
  return new Map(r.from.flatMap((f, i) => TONES.map((t) => [colorIndex(f, t), colorIndex(v.to[i] ?? f, t)] as [number, number])));
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
          variants: r.variants.map((v, i) => ({ variant: r.existing + i, id: v.id, colors: v.to.flatMap((t) => [...RAMPS[t]]) })),
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
    if (kind === "rug") shipped.push({ variant: "navy", images: [rugPatch(room)] });
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

/** Contact sheet: one row per kind, one cell per variant (shipped, then the 2 new), every facing in a cell. Light panel = the
 *  room floor, dark panel = the site bg (#1d1a2b), one above the other. A thin cream rule marks where the new variants start. */
export function recolourSheet(): { w: number; h: number; img: Uint8Array; palette: RGBA[] } {
  const cells = recolourCells();
  const kinds = [...new Set(cells.map((c) => c.kind))];
  const GAP = 4, PAD = 8;
  const cellW = (c: (typeof cells)[number]): number => c.images.reduce((s, m) => s + m.w + GAP, GAP);
  const colW = Array.from({ length: 4 }, (_, i) => Math.max(...kinds.map((k) => { const c = cells.filter((x) => x.kind === k)[i]; return c ? cellW(c) : 0; })));
  const rowH = kinds.map((k) => Math.max(...cells.filter((c) => c.kind === k).flatMap((c) => c.images.map((m) => m.h))) + 2 * GAP);
  const panelW = colW.reduce((a, b) => a + b, 0), panelH = rowH.reduce((a, b) => a + b, 0);
  const w = panelW, h = panelH * 2 + PAD;
  const palette = [...PALETTE, { r: 0x1d, g: 0x1a, b: 0x2b, a: 255 }];
  const DARK = palette.length - 1, LIGHT = colorIndex("floor", 1), RULE = colorIndex("cream", 0);
  const img = new Uint8Array(w * h).fill(colorIndex("cream", 1));
  img.fill(LIGHT, 0, panelH * w);
  img.fill(DARK, (panelH + PAD) * w);
  for (const py of [0, panelH + PAD]) {
    let y0 = py;
    kinds.forEach((k, ri) => {
      const row = cells.filter((c) => c.kind === k);
      const shipped = (RECOLOURS[k]?.existing ?? 0);
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
  }
  return { w, h, img, palette };
}
