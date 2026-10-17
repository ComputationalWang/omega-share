// Shirt tints (OME-1347): 6 per avatar, tint 0 = the shipped look. A tint swaps the avatar's swatch ramp (its shirt /
// accent, never skin or hair) for another ramp of the shared palette, so no new colours and no new frames.
// Runtime palette swap, not a bake: the 3 swatch entries are rewritten in the sheet's PLTE (see README, "Shirt tints").
import { AVATARS, composeFrame, composeMotion, viewOf, type AvatarDef } from "./avatars";
import { walkMotion } from "./motion";
import { PALETTE, RAMPS, colorIndex, type RampName, type Tone } from "./palette";
import type { RGBA } from "./png";
import { render } from "./sprite";

const TONES: readonly Tone[] = [0, 1, 2];

/** Tint ramps per avatar; [0] is the avatar's swatch. Picked to stay clear of that avatar's own skin, hair, trousers and props. */
export const TINTS: Readonly<Record<string, readonly RampName[]>> = {
  juno: ["mustard", "teal", "rust", "lilac", "pink", "olive"],
  pip: ["teal", "mustard", "lilac", "pink", "olive", "velvet"],
  mo: ["rust", "teal", "mustard", "lilac", "pink", "velvet"],
  kiki: ["lilac", "teal", "navy", "rust", "olive", "ginger"],
};

/** Roles allowed to carry the swatch ramp: tops, far arm, Kiki's pinafore lap, Pip's beanie band + pom-pom. */
const TINTABLE = new Set(["T", "o", "r", "x", "B", "b", "P"]);

function tintsOf(a: AvatarDef): readonly RampName[] {
  const t = TINTS[a.id];
  if (t?.length !== 6 || t[0] !== a.swatch) throw new Error(`${a.id}: need 6 tints starting with its swatch ${a.swatch}`);
  return t;
}

/** The swatch ramp must sit only on tintable roles, and no tint may reuse a ramp the avatar already wears elsewhere. */
export function assertTintable(a: AvatarDef): void {
  const other = new Set<RampName>();
  for (const [role, spec] of Object.entries(a.roles)) {
    if (spec.ramp !== a.swatch) other.add(spec.ramp);
    else if (!TINTABLE.has(role)) throw new Error(`${a.id}: role ${role} uses the swatch ramp but is not a shirt/accent role`);
  }
  for (const r of tintsOf(a)) if (other.has(r)) throw new Error(`${a.id}: tint ${r} clashes with a ramp the avatar already wears`);
}

/** Index remap for baked previews: swatch tone index → tint tone index (both in PALETTE). */
export function tintRemap(a: AvatarDef, tint: number): Map<number, number> {
  const to = tintsOf(a)[tint];
  if (!to) throw new Error(`${a.id}: no tint ${String(tint)}`);
  return new Map(TONES.map((t) => [colorIndex(a.swatch, t), colorIndex(to, t)]));
}

export function applyRemap(img: Uint8Array, remap: ReadonlyMap<number, number>): Uint8Array {
  return img.map((v) => remap.get(v) ?? v);
}

// CIE76 ΔE in Lab (D65): good enough to rank flat pixel colours.
function lab(h: string): [number, number, number] {
  const n = Number.parseInt(h.slice(1), 16);
  const lin = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => lin(c / 255)) as [number, number, number];
  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047), y = f(0.2126 * r + 0.7152 * g + 0.0722 * b), z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
export function deltaE(a: string, b: string): number {
  const [p, q] = [lab(a), lab(b)];
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

/** tints.json: what the client needs for the PLTE swap, plus the ΔE self-check numbers. */
export function tintsTable(): object {
  return {
    license: "CC-BY-SA-4.0",
    method: "runtime PLTE swap: in avatars.png, motion.png and expressions.png replace PLTE entry slots[t] with tints[n].colors[t] (t = 0 highlight, 1 base, 2 shade); use the copy only for that avatar's frames",
    sheets: ["avatars.png", "motion.png", "expressions.png"],
    avatars: Object.fromEntries(
      AVATARS.map((a) => {
        assertTintable(a);
        return [a.id, { slots: TONES.map((t) => colorIndex(a.swatch, t)), tints: tintsOf(a).map((r) => ({ id: r, colors: [...RAMPS[r]] })) }];
      }),
    ),
  };
}

/** Smallest base-tone ΔE between two tints of one avatar, and between any tint and that avatar's skin / hair base. */
export function tintSpread(a: AvatarDef): { tints: number; skinHair: number } {
  const base = tintsOf(a).map((r) => RAMPS[r][1]);
  let tints = Infinity;
  base.forEach((c, i) => {
    for (const d of base.slice(i + 1)) tints = Math.min(tints, deltaE(c, d));
  });
  const keep = ["S", "H"].flatMap((role) => (a.roles[role] ? [RAMPS[a.roles[role].ramp][1]] : []));
  const skinHair = Math.min(...base.flatMap((c) => keep.map((k) => deltaE(c, k))));
  return { tints, skinHair };
}

/** Contact sheet: 6 tint columns × 4 avatar rows, each cell idle SE + walk SW (frame 1); a light (floor) and a dark (site bg) panel. */
export function contactSheet(): { w: number; h: number; img: Uint8Array; palette: RGBA[] } {
  const CW = 64, CH = 64, PAD = 8, cols = 6;
  const panelH = AVATARS.length * CH;
  const w = cols * CW, h = panelH * 2 + PAD;
  // The site background (#1d1a2b, apps/web style.css) as one extra entry; the light panel is the room floor.
  const palette = [...PALETTE, { r: 0x1d, g: 0x1a, b: 0x2b, a: 255 }];
  const DARK = PALETTE.length, LIGHT = colorIndex("floor", 1);
  const img = new Uint8Array(w * h).fill(colorIndex("cream", 1));
  for (let p = 0; p < 2; p++) img.fill(p === 0 ? LIGHT : DARK, p * (panelH + PAD) * w, (p * (panelH + PAD) + panelH) * w);
  AVATARS.forEach((a, row) => {
    const idle = render(composeFrame(a, "idle", "se", false), a.roles);
    const walk = render(composeMotion(a, "idle", "sw", walkMotion(viewOf("sw"), 1, a.holds === true)), a.roles);
    for (let t = 0; t < cols; t++) {
      const remap = tintRemap(a, t);
      for (let p = 0; p < 2; p++) {
        const oy = p * (panelH + PAD) + row * CH;
        [applyRemap(idle, remap), applyRemap(walk, remap)].forEach((cell, k) => {
          for (let y = 0; y < CH; y++)
            for (let x = 0; x < 32; x++) {
              const v = cell[y * 32 + x] ?? 0;
              if (v !== 0) img[(oy + y) * w + t * CW + k * 32 + x] = v;
            }
        });
      }
    }
  });
  return { w, h, img, palette };
}
