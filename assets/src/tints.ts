// Shirt tints (OME-1347): 6 per avatar, tint 0 = the shipped look. A tint swaps the avatar's swatch ramp (its shirt /
// accent, never skin or hair) for another ramp of the shared palette, so no new colours and no new frames.
// Runtime palette swap, not a bake: the 3 swatch entries are rewritten in the sheet's PLTE (see README, "Shirt tints").
// OME-1360: every tint clears 3:1 on the dark site bg and stays ΔE ≥ 20 from its siblings under deuteranopia and
// protanopia too. That needs 4 tint-only ramps; they live in tints.json, never in PALETTE, so no sheet byte changes.
import { AVATARS, composeFrame, composeMotion, viewOf, type AvatarDef } from "./avatars";
import { walkMotion } from "./motion";
import { PALETTE, RAMPS, colorIndex, type RampName, type Tone } from "./palette";
import type { RGBA } from "./png";
import { render } from "./sprite";

const TONES: readonly Tone[] = [0, 1, 2];

/** Tint-only ramps (highlight, base, shade): denim is navy lifted to 3:1, berry is velvet lifted; ice and lemon are a light blue/yellow pair. */
export const TINT_RAMPS = {
  denim: ["#5f8cf0", "#3366e0", "#2445a0"],
  ice: ["#c4f4f7", "#8fe3ec", "#5ab0c4"],
  lemon: ["#fbf0a6", "#f0dc6e", "#c4ac44"],
  berry: ["#e0708c", "#c0466a", "#8a2e4c"],
} as const satisfies Record<string, readonly [string, string, string]>;
export type TintName = RampName | keyof typeof TINT_RAMPS;
export const tintRamp = (n: TintName): readonly string[] => (n in TINT_RAMPS ? TINT_RAMPS[n as keyof typeof TINT_RAMPS] : RAMPS[n as RampName]);

/** Preview palette: PALETTE, then the tint-only colours. Index of tint-only tone t of ramp k = PALETTE.length + 3k + t. */
const TINT_NAMES = Object.keys(TINT_RAMPS) as (keyof typeof TINT_RAMPS)[];
export const TINT_PALETTE: RGBA[] = [...PALETTE, ...TINT_NAMES.flatMap((n) => TINT_RAMPS[n].map(rgba))];
function tintIndex(n: TintName, t: Tone): number {
  const k = TINT_NAMES.indexOf(n as keyof typeof TINT_RAMPS);
  return k < 0 ? colorIndex(n as RampName, t) : PALETTE.length + 3 * k + t;
}

/** Tint ramps per avatar; [0] is the avatar's swatch. Picked to stay clear of that avatar's own skin, hair, trousers and props. */
export const TINTS: Readonly<Record<string, readonly TintName[]>> = {
  juno: ["mustard", "teal", "lilac", "olive", "ice", "denim"],
  pip: ["teal", "lilac", "lemon", "ice", "denim", "berry"],
  mo: ["rust", "mustard", "teal", "lilac", "ice", "berry"],
  kiki: ["lilac", "rust", "lemon", "ice", "berry", "denim"],
};

/** Roles allowed to carry the swatch ramp: tops, far arm, Kiki's pinafore lap, Pip's beanie band + pom-pom. */
const TINTABLE = new Set(["T", "o", "r", "x", "B", "b", "P"]);

function tintsOf(a: AvatarDef): readonly TintName[] {
  const t = TINTS[a.id];
  if (t?.length !== 6 || t[0] !== a.swatch) throw new Error(`${a.id}: need 6 tints starting with its swatch ${a.swatch}`);
  return t;
}

/** The swatch ramp must sit only on tintable roles, and no tint may reuse a ramp the avatar already wears elsewhere. */
export function assertTintable(a: AvatarDef): void {
  const other = new Set<TintName>();
  for (const [role, spec] of Object.entries(a.roles)) {
    if (spec.ramp !== a.swatch) other.add(spec.ramp);
    else if (!TINTABLE.has(role)) throw new Error(`${a.id}: role ${role} uses the swatch ramp but is not a shirt/accent role`);
  }
  for (const r of tintsOf(a)) if (other.has(r)) throw new Error(`${a.id}: tint ${r} clashes with a ramp the avatar already wears`);
}

/** Index remap for baked previews: swatch tone index → tint tone index (both in TINT_PALETTE). */
export function tintRemap(a: AvatarDef, tint: number): Map<number, number> {
  const to = tintsOf(a)[tint];
  if (!to) throw new Error(`${a.id}: no tint ${String(tint)}`);
  return new Map(TONES.map((t) => [colorIndex(a.swatch, t), tintIndex(to, t)]));
}

export function applyRemap(img: Uint8Array, remap: ReadonlyMap<number, number>): Uint8Array {
  return img.map((v) => remap.get(v) ?? v);
}

function rgba(h: string): RGBA {
  const n = Number.parseInt(h.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 255 };
}

export type Vision = "normal" | "deutan" | "protan";
export const VISIONS: readonly Vision[] = ["normal", "deutan", "protan"];
// Machado, Oliveira & Fernandes 2009, severity 1.0, applied in linear RGB.
const CVD: Record<Vision, readonly number[]> = {
  normal: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  deutan: [0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.01182, 0.04294, 0.968881],
  protan: [0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998],
};
const lin = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
function linear(h: string, v: Vision): [number, number, number] {
  const c = rgba(h);
  const [r, g, b] = [c.r, c.g, c.b].map((x) => lin(x / 255)) as [number, number, number];
  const m = CVD[v];
  const row = (i: number): number => clamp01((m[i] ?? 0) * r + (m[i + 1] ?? 0) * g + (m[i + 2] ?? 0) * b);
  return [row(0), row(3), row(6)];
}
/** A colour as seen with that vision, as #rrggbb (for the contact sheet's deutan/protan panels). */
export function simulate(h: string, v: Vision): string {
  const enc = (c: number): number => Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
  return "#" + linear(h, v).map((c) => enc(c).toString(16).padStart(2, "0")).join("");
}

// CIE76 ΔE in Lab (D65): good enough to rank flat pixel colours.
function lab(h: string, v: Vision): [number, number, number] {
  const [r, g, b] = linear(h, v);
  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047), y = f(0.2126 * r + 0.7152 * g + 0.0722 * b), z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
export function deltaE(a: string, b: string, v: Vision = "normal"): number {
  const [p, q] = [lab(a, v), lab(b, v)];
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}
/** Smallest ΔE across normal, deutan and protan vision. */
export const cvdDeltaE = (a: string, b: string): number => Math.min(...VISIONS.map((v) => deltaE(a, b, v)));

/** WCAG contrast ratio between two colours. */
export function contrast(a: string, b: string): number {
  const y = (h: string): number => {
    const [r, g, bl] = linear(h, "normal");
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [y(a), y(b)].sort((p, q) => q - p) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** tints.json: what the client needs for the PLTE swap, plus the ΔE self-check numbers. */
export function tintsTable(): object {
  return {
    license: "CC-BY-SA-4.0",
    method: "runtime PLTE swap: in avatars.png, motion.png, expressions.png and watching.png replace PLTE entry slots[t] with tints[n].colors[t] (t = 0 highlight, 1 base, 2 shade); use the copy only for that avatar's frames",
    sheets: ["avatars.png", "motion.png", "expressions.png", "watching.png"],
    avatars: Object.fromEntries(
      AVATARS.map((a) => {
        assertTintable(a);
        return [a.id, { slots: TONES.map((t) => colorIndex(a.swatch, t)), tints: tintsOf(a).map((r) => ({ id: r, colors: [...tintRamp(r)] })) }];
      }),
    ),
  };
}

/** Smallest base-tone ΔE between two tints of one avatar (`cvd`: also under deutan and protan), and between any tint and
 *  that avatar's skin / hair base. */
export function tintSpread(a: AvatarDef): { tints: number; cvd: number; skinHair: number } {
  const base = tintsOf(a).map((r) => tintRamp(r)[1] ?? "");
  let tints = Infinity, cvd = Infinity;
  base.forEach((c, i) => {
    for (const d of base.slice(i + 1)) {
      tints = Math.min(tints, deltaE(c, d));
      cvd = Math.min(cvd, cvdDeltaE(c, d));
    }
  });
  const keep = ["S", "H"].flatMap((role) => (a.roles[role] ? [RAMPS[a.roles[role].ramp][1]] : []));
  const skinHair = Math.min(...base.flatMap((c) => keep.map((k) => deltaE(c, k))));
  return { tints, cvd, skinHair };
}

/** Contact sheet: 6 tint columns × 4 avatar rows, each cell idle SE + walk SW (frame 1). Panels: light (floor), dark
 *  (site bg), then the light panel as seen with deuteranopia and with protanopia. */
export function contactSheet(): { w: number; h: number; img: Uint8Array; palette: RGBA[] } {
  const CW = 64, CH = 64, PAD = 8, cols = 6;
  // panel → [vision, background]: the CVD panels shift every index into that vision's copy of the palette.
  const PANELS: readonly [Vision, "light" | "dark"][] = [["normal", "light"], ["normal", "dark"], ["deutan", "light"], ["protan", "light"]];
  const panelH = AVATARS.length * CH;
  const w = cols * CW, h = panelH * PANELS.length + PAD * (PANELS.length - 1);
  // The site background (#1d1a2b, apps/web style.css) as one extra entry; the light panel is the room floor.
  const base = [...TINT_PALETTE, rgba("#1d1a2b")];
  const hexOf = (c: RGBA): string => "#" + [c.r, c.g, c.b].map((x) => x.toString(16).padStart(2, "0")).join("");
  const palette = VISIONS.flatMap((v) => base.map((c) => ({ ...rgba(simulate(hexOf(c), v)), a: c.a })));
  const shift = (v: Vision): number => VISIONS.indexOf(v) * base.length;
  const DARK = base.length - 1, LIGHT = colorIndex("floor", 1);
  const img = new Uint8Array(w * h).fill(colorIndex("cream", 1));
  PANELS.forEach(([v, bg], p) => img.fill((bg === "light" ? LIGHT : DARK) + shift(v), p * (panelH + PAD) * w, (p * (panelH + PAD) + panelH) * w));
  AVATARS.forEach((a, row) => {
    const idle = render(composeFrame(a, "idle", "se", false), a.roles);
    const walk = render(composeMotion(a, "idle", "sw", walkMotion(viewOf("sw"), 1, a.holds === true)), a.roles);
    for (let t = 0; t < cols; t++) {
      const remap = tintRemap(a, t);
      PANELS.forEach(([v], p) => {
        const oy = p * (panelH + PAD) + row * CH;
        [applyRemap(idle, remap), applyRemap(walk, remap)].forEach((cell, k) => {
          for (let y = 0; y < CH; y++)
            for (let x = 0; x < 32; x++) {
              const c = cell[y * 32 + x] ?? 0;
              if (c !== 0) img[(oy + y) * w + t * CW + k * 32 + x] = c + shift(v);
            }
        });
      });
    }
  });
  return { w, h, img, palette };
}
