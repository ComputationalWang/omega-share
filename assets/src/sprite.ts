// Role-grid sprites: templates are drawn with role letters, then mapped to palette ramps,
// auto-shaded (light from the top-left) and auto-outlined (1 px, 4-connected, plum).
import { OUTLINE, colorIndex, type RampName, type Tone } from "./palette";

export type Grid = string[][];

export interface RoleSpec {
  ramp: RampName;
  /** Fixed tone: no auto shading (eyes, mouths, glasses, stripes). */
  tone?: Tone;
  /** Pixels in the same group count as one surface for edge shading. Defaults to the role letter. */
  group?: string;
  /** Allow a highlight on the top/left edge. */
  hi?: boolean;
}

export type RoleMap = Readonly<Record<string, RoleSpec>>;

export function blank(w: number, h: number): Grid {
  return Array.from({ length: h }, () => Array.from({ length: w }, () => "."));
}

/** Stamp rows at (x, y). "." keeps what is below, "_" erases to transparent. */
export function stamp(g: Grid, rows: readonly string[], x: number, y: number): void {
  rows.forEach((row, dy) => {
    const line = g[y + dy];
    if (!line) return;
    for (let dx = 0; dx < row.length; dx++) {
      const ch = row.charAt(dx);
      const cx = x + dx;
      if (ch === "." || cx < 0 || cx >= line.length) continue;
      line[cx] = ch === "_" ? "." : ch;
    }
  });
}

export function mirror(g: Grid): Grid {
  return g.map((row) => [...row].reverse());
}

export function at(g: Grid, x: number, y: number): string {
  return g[y]?.[x] ?? ".";
}

/** Map a role grid to palette indices with shading and outline. Returns row-major indices. */
export function render(g: Grid, roles: RoleMap): Uint8Array {
  const h = g.length;
  const w = g[0]?.length ?? 0;
  const out = new Uint8Array(w * h);
  const groupAt = (x: number, y: number): string => {
    const ch = at(g, x, y);
    if (ch === ".") return ".";
    return roles[ch]?.group ?? ch;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ch = at(g, x, y);
      if (ch === ".") continue;
      const spec = roles[ch];
      if (!spec) throw new Error(`unknown role "${ch}" at ${String(x)},${String(y)}`);
      let tone: Tone = 1;
      if (spec.tone !== undefined) tone = spec.tone;
      else {
        const me = spec.group ?? ch;
        const same = (dx: number, dy: number): boolean => groupAt(x + dx, y + dy) === me;
        if (!same(1, 0) || !same(0, 1)) tone = 2;
        else if (spec.hi === true && (!same(0, -1) || !same(-1, 0))) tone = 0;
      }
      out[y * w + x] = colorIndex(spec.ramp, tone);
    }
  }
  // Outline: transparent pixels touching the silhouette (4-connected).
  const filled = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < w && y < h && at(g, x, y) !== ".";
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (filled(x, y)) continue;
      if (filled(x + 1, y) || filled(x - 1, y) || filled(x, y + 1) || filled(x, y - 1)) out[y * w + x] = OUTLINE;
    }
  }
  return out;
}

/** Copy a w×h index image into a sheet at (ox, oy). */
export function blit(sheet: Uint8Array, sheetW: number, img: Uint8Array, w: number, h: number, ox: number, oy: number): void {
  for (let y = 0; y < h; y++) sheet.set(img.subarray(y * w, (y + 1) * w), (oy + y) * sheetW + ox);
}

/** Nearest-neighbour integer upscale (for previews only). */
export function upscale(img: Uint8Array, w: number, h: number, k: number): Uint8Array {
  const out = new Uint8Array(w * k * h * k);
  for (let y = 0; y < h * k; y++) {
    for (let x = 0; x < w * k; x++) out[y * w * k + x] = img[Math.floor(y / k) * w + Math.floor(x / k)] ?? 0;
  }
  return out;
}
