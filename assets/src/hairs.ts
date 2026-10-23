// Hair colours (OME-1436): 6 per avatar, hair 0 = the shipped look. The same runtime PLTE swap as the shirt tints (tints.ts):
// the avatar's hair ramp sits at 3 PLTE entries, and a hair colour overwrites them. No new frames, no new sheet bytes beyond
// two hair-only ramps (`hairPink`, `hairGinger` in palette.ts). Hair and tint slots are disjoint, so the two swaps compose in either order.
import { BARE } from "./accessories";
import { AVATARS, composeFrame, type AvatarDef } from "./avatars";
import { RAMPS, colorIndex, type RampName, type Tone } from "./palette";
import type { RGBA } from "./png";
import { render } from "./sprite";
import { TINT_PALETTE, TINTS, applyRemap, contrast, cvdDeltaE, deltaE, tintRamp, tintRemap } from "./tints";

const TONES: readonly Tone[] = [0, 1, 2];

/** Hair-only ramps (highlight, base, shade): they live in hairs.json, never in PALETTE. */
export const HAIR_RAMPS = {
  blonde: ["#fbe7a8", "#e9cd7c", "#b89a52"],
  chestnut: ["#b06a40", "#8a4a2c", "#5e301e"],
  silver: ["#eeecf4", "#c4c0d4", "#8e8aa4"],
  cherry: ["#f0707a", "#d0404e", "#902836"],
  sky: ["#9cd4fa", "#5aa8ec", "#356cb4"],
  mint: ["#b4f0c0", "#78d098", "#449a6c"],
  violet: ["#b48cf0", "#8a5ad8", "#5a3a9c"],
} as const satisfies Record<string, readonly [string, string, string]>;
export type HairName = RampName | keyof typeof HAIR_RAMPS;
export const hairRamp = (n: HairName): readonly string[] => (n in HAIR_RAMPS ? HAIR_RAMPS[n as keyof typeof HAIR_RAMPS] : RAMPS[n as RampName]);

/** Hair colours per avatar; [0] is the avatar's `H` ramp. Picked ΔE ≥ 20 from each other (also under deutan/protan), from
 *  that avatar's skin and from every one of its shirt tints. */
export const HAIRS: Readonly<Record<string, readonly HairName[]>> = {
  juno: ["hairDark", "ginger", "blonde", "silver", "cherry", "sky"],
  pip: ["hairGinger", "hairDark", "chestnut", "silver", "mint", "violet"],
  mo: ["hairDark", "ginger", "blonde", "silver", "sky", "violet"],
  kiki: ["hairPink", "hairDark", "ginger", "chestnut", "sky", "violet"],
};

/** Roles that carry the hair ramp: hair, plus Mo's beard (`b`). */
const HAIR_ROLES = new Set(["H", "q", "b"]);

const hairOf = (a: AvatarDef): RampName => {
  const h = a.roles["H"]?.ramp;
  if (!h) throw new Error(`${a.id}: no hair role`);
  return h;
};
function hairsOf(a: AvatarDef): readonly HairName[] {
  const h = HAIRS[a.id];
  if (h?.length !== 6 || h[0] !== hairOf(a)) throw new Error(`${a.id}: need 6 hair colours starting with its hair ramp ${hairOf(a)}`);
  return h;
}

/** The hair ramp's colours must sit only on hair roles (no other ramp may share a hex with it), and must not share a PLTE
 *  entry with the avatar's tint slots. */
export function assertHairOnly(a: AvatarDef): void {
  const hair = hairOf(a), hex = new Set<string>(RAMPS[hair]);
  for (const [role, spec] of Object.entries(a.roles)) {
    const shares = RAMPS[spec.ramp].some((h) => hex.has(h));
    if (shares && !HAIR_ROLES.has(role)) throw new Error(`${a.id}: role ${role} (${spec.ramp}) shares a hair colour`);
  }
  const tint = new Set(TONES.map((t) => colorIndex(a.swatch, t)));
  for (const s of hairSlots(a)) if (tint.has(s)) throw new Error(`${a.id}: hair slot ${String(s)} is also a tint slot`);
}
export const hairSlots = (a: AvatarDef): number[] => TONES.map((t) => colorIndex(hairOf(a), t));

/** Preview palette: TINT_PALETTE, then the hair-only colours. */
const HAIR_NAMES = Object.keys(HAIR_RAMPS) as (keyof typeof HAIR_RAMPS)[];
export const HAIR_PALETTE: RGBA[] = [...TINT_PALETTE, ...HAIR_NAMES.flatMap((n) => HAIR_RAMPS[n].map(rgba))];
function hairIndex(n: HairName, t: Tone): number {
  const k = HAIR_NAMES.indexOf(n as keyof typeof HAIR_RAMPS);
  return k < 0 ? colorIndex(n as RampName, t) : TINT_PALETTE.length + 3 * k + t;
}

/** Index remap for baked previews: hair tone index → hair colour tone index (in HAIR_PALETTE). */
export function hairRemap(a: AvatarDef, hair: number): Map<number, number> {
  const to = hairsOf(a)[hair];
  if (!to) throw new Error(`${a.id}: no hair ${String(hair)}`);
  return new Map(TONES.map((t) => [colorIndex(hairOf(a), t), hairIndex(to, t)]));
}

/** Hair × tint as one remap over the original indexes (the key sets are disjoint, so no pixel is remapped twice). */
export function lookRemap(a: AvatarDef, hair: number, tint: number): Map<number, number> {
  return new Map([...tintRemap(a, tint), ...hairRemap(a, hair)]);
}

function rgba(h: string): RGBA {
  const n = Number.parseInt(h.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 255 };
}

/** Smallest base-tone ΔE: between two hair colours of one avatar (`cvd`: also under deutan and protan), to its skin, to
 *  any of its tints, and the lowest contrast against the dark site bg. */
export function hairSpread(a: AvatarDef): { hairs: number; cvd: number; skin: number; tint: number; bg: number } {
  const base = hairsOf(a).map((r) => hairRamp(r)[1] ?? "");
  let hairs = Infinity, cvd = Infinity;
  base.forEach((c, i) => {
    for (const d of base.slice(i + 1)) {
      hairs = Math.min(hairs, deltaE(c, d));
      cvd = Math.min(cvd, cvdDeltaE(c, d));
    }
  });
  const skinRamp = a.roles["S"]?.ramp;
  const skinC = skinRamp ? RAMPS[skinRamp][1] : "#000000";
  const tints = (TINTS[a.id] ?? []).map((t) => tintRamp(t)[1] ?? "");
  return {
    hairs,
    cvd,
    skin: Math.min(...base.map((c) => deltaE(c, skinC))),
    tint: Math.min(...base.flatMap((c) => tints.map((t) => deltaE(c, t)))),
    bg: Math.min(...base.slice(1).map((c) => contrast(c, "#1d1a2b"))),
  };
}

/** hairs.json: the PLTE-swap table, same shape as tints.json. */
export function hairsTable(): object {
  return {
    license: "CC-BY-SA-4.0",
    method: "runtime PLTE swap, like tints.json: in each sheet replace PLTE entry slots[t] with hairs[n].colors[t] (t = 0 highlight, 1 base, 2 shade); use the copy only for that avatar's frames. Hair slots and tint slots never overlap, so apply both to the same copy in either order",
    sheets: ["avatars.png", "motion.png", "expressions.png", "watching.png", "dungeon.png", "../accessories/bare.png"],
    // Hat overlays redraw the hair around the hat in the avatar's hair slots; swap them for that avatar's hat frames too.
    overlays: ["../accessories/accessories.png", ...["halloween", "sinterklaas", "christmas", "valentines", "easter"].map((t) => `../themes/${t}/${t}.png`)],
    avatars: Object.fromEntries(
      AVATARS.map((a) => {
        assertHairOnly(a);
        return [a.id, { slots: hairSlots(a), hairs: hairsOf(a).map((r) => ({ id: r, colors: [...hairRamp(r)] })) }];
      }),
    ),
  };
}

/** Contact sheet: 6 hair columns × 4 avatar rows, then a mixed hair × tint row. Each cell: idle SE, idle NW, and the bare
 *  head (Pip, Mo) or sitting SW (Juno, Kiki). Panels: light floor, then dark site bg. */
export function hairSheet(): { w: number; h: number; img: Uint8Array; palette: RGBA[] } {
  const CW = 96, CH = 64, cols = 6, rows = AVATARS.length + 1, PAD = 8;
  const panelH = rows * CH + PAD;
  const w = cols * CW, h = panelH * 2 - PAD;
  const palette = [...HAIR_PALETTE, rgba("#1d1a2b")];
  const DARK = palette.length - 1, LIGHT = colorIndex("floor", 1);
  const img = new Uint8Array(w * h).fill(colorIndex("cream", 1));
  [LIGHT, DARK].forEach((bg, p) => img.fill(bg, p * panelH * w, (p * panelH + rows * CH) * w));
  const sprites = (a: AvatarDef): Uint8Array[] => {
    const bare = BARE.get(a.id);
    return [
      render(composeFrame(a, "idle", "se", false), a.roles),
      render(composeFrame(a, "idle", "nw", false), a.roles),
      bare ? render(composeFrame(bare, "idle", "se", false), bare.roles) : render(composeFrame(a, "sit", "sw", false), a.roles),
    ];
  };
  const put = (cell: readonly Uint8Array[], col: number, row: number): void => { [0, 1].forEach((p) => { cell.forEach((s, k) => {
        for (let y = 0; y < CH; y++)
          for (let x = 0; x < 32; x++) {
            const c = s[y * 32 + x] ?? 0;
            if (c !== 0) img[(p * panelH + row * CH + y) * w + col * CW + k * 32 + x] = c;
          }
      }); },
    ); };
  AVATARS.forEach((a, row) => {
    const base = sprites(a);
    for (let n = 0; n < cols; n++) put(base.map((s) => applyRemap(s, hairRemap(a, n))), n, row);
  });
  // Mixed row: avatar k % 4, hair k, tint 5 - k, so every column pairs a different hair with a different tint.
  for (let k = 0; k < cols; k++) {
    const a = AVATARS[k % AVATARS.length];
    if (a) put(sprites(a).map((s) => applyRemap(s, lookRemap(a, k, cols - 1 - k))), k, AVATARS.length);
  }
  return { w, h, img, palette };
}
