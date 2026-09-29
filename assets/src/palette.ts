// "Dusk Lounge" shared palette. Every omega-share sprite uses only these colours.
// Ramps are [highlight, base, shade]; light comes from the top-left.
import type { RGBA } from "./png";

function hex(h: string): RGBA {
  const n = Number.parseInt(h.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 255 };
}

export const RAMPS = {
  outline: ["#2b1d2f", "#2b1d2f", "#2b1d2f"],
  skinDeep: ["#9a6446", "#7a4a33", "#5a3426"],
  skinMedium: ["#d39a6e", "#b97a52", "#8e5a3c"],
  skinTan: ["#ecbd8f", "#d9a172", "#b07650"],
  skinLight: ["#fde6cf", "#f6cfae", "#dca786"],
  mustard: ["#f7d36b", "#e8b33c", "#b9822a"],
  teal: ["#6fd0c4", "#3aa7a3", "#23706f"],
  rust: ["#e07a55", "#c2553a", "#8a3527"],
  lilac: ["#c6a8ec", "#a17fd0", "#6f55a0"],
  pink: ["#f7b3c8", "#f08fb0", "#c2607f"],
  cream: ["#fff7ea", "#f4ead2", "#cbbd9f"],
  navy: ["#56679c", "#3d4c7a", "#2a3458"],
  charcoal: ["#655a70", "#4a4052", "#332b3a"],
  olive: ["#a0ad5a", "#7d8a3e", "#5a6429"],
  ginger: ["#f09a4e", "#d9772e", "#a4531d"],
  hairDark: ["#5a4038", "#3a2a2a", "#261a1c"],
  blush: ["#f2a08e", "#e88a7a", "#c86a5e"],
  // Room colours (set b) share this file so the whole game stays on one palette.
  wood: ["#c98e5a", "#a86e40", "#7c4d2c"],
  wall: ["#8a6f9e", "#6d5584", "#523f66"],
  floor: ["#d9b98c", "#c49f70", "#a47f55"],
  glow: ["#e8fbff", "#b8e6f0", "#7fbfd0"],
} as const satisfies Record<string, readonly [string, string, string]>;

export type RampName = keyof typeof RAMPS;
export type Tone = 0 | 1 | 2; // 0 highlight, 1 base, 2 shade

/** Palette index 0 is fully transparent; the rest are the unique ramp colours in order. */
export const PALETTE: RGBA[] = [{ r: 0, g: 0, b: 0, a: 0 }];
const indexByHex = new Map<string, number>();
for (const ramp of Object.values(RAMPS)) {
  for (const h of ramp) {
    if (!indexByHex.has(h)) {
      indexByHex.set(h, PALETTE.length);
      PALETTE.push(hex(h));
    }
  }
}

export function colorIndex(ramp: RampName, tone: Tone): number {
  const idx = indexByHex.get(RAMPS[ramp][tone]);
  if (idx === undefined) throw new Error(`no palette entry for ${ramp}/${String(tone)}`);
  return idx;
}

export const OUTLINE = colorIndex("outline", 1);
