// Set (j) (OME-422): the Chrome Web Store kit's pixel art. The extension icon is drawn natively at each size (16, 32, 48 art px,
// and 64 art px shown at 2× for the 128 px icon), never shrunk from a big one, so every size keeps the plum outline and whole pixels.
// The icon: the room's wood TV showing the dusk stand-in picture (sky, sun on the sea), and from 48 up, two avatars watching it
// from behind (Juno's puff, Kiki's buns): "a little room where friends watch together". No lettering, no third-party marks.
// The promo tile and screenshots are composed in preview/store.html and shot by src/shoot-ui.ts.
import { PALETTE } from "./palette";
import type { RGBA } from "./png";
import { blank, render, upscale, type Grid, type RoleMap } from "./sprite";

const ROLES: RoleMap = {
  w: { ramp: "wood", hi: true },
  o: { ramp: "outline", tone: 1, group: "w" },
  y: { ramp: "glow", tone: 0, group: "w" },
  m: { ramp: "mustard", hi: true },
  // The picture: flat bands, one surface, so only the bezel is auto-shaded.
  L: { ramp: "lilac", tone: 1, group: "s" },
  l: { ramp: "lilac", tone: 0, group: "s" },
  P: { ramp: "pink", tone: 0, group: "s" },
  S: { ramp: "mustard", tone: 0, group: "s" },
  s: { ramp: "mustard", tone: 1, group: "s" },
  T: { ramp: "teal", tone: 0, group: "s" },
  t: { ramp: "teal", tone: 2, group: "s" },
  N: { ramp: "navy", tone: 0, group: "s" },
  // The two watchers, seen from behind.
  H: { ramp: "hairDark", hi: true },
  K: { ramp: "pink", hi: true },
  h: { ramp: "mustard", hi: true },
  v: { ramp: "lilac", hi: true },
};

/** One icon at `S` art px. `pad` = transparent margin (the 128 px icon keeps Chrome's 16 px, i.e. 8 art px at 2×). */
function icon(S: number, pad: number): Grid {
  const g = blank(S, S);
  const set = (x: number, y: number, ch: string): void => { const r = g[y]; if (r && x >= 0 && x < S) r[x] = ch; };
  const A = S - 2 * pad;
  const heads = S >= 48;
  const antenna = S >= 32 ? Math.round(A * 0.14) : 0;
  const legs = S >= 32 ? Math.max(1, Math.round(A * 0.05)) : 1;
  const x0 = pad + 1, x1 = S - pad - 2;
  const y0 = pad + 1 + antenna, y1 = S - pad - 2 - legs;
  const cham = S >= 32 ? 2 : 1;
  const bezel = Math.max(1, Math.round(A * 0.08));
  // Cabinet with chamfered corners (2:1 stair like the UI's).
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const dx = Math.min(x - x0, x1 - x), dy = Math.min(y - y0, y1 - y);
    if (dx + Math.floor(dy / 1) < cham && dy < cham) continue;
    set(x, y, "w");
  }
  // Legs and antenna.
  for (let k = 1; k <= legs; k++) { set(x0 + bezel + 1, y1 + k, "w"); set(x1 - bezel - 1, y1 + k, "w"); if (S >= 48) { set(x0 + bezel + 2, y1 + k, "w"); set(x1 - bezel - 2, y1 + k, "w"); } }
  if (antenna > 0) {
    const cx = Math.floor((x0 + x1) / 2);
    for (let k = 1; k <= antenna; k++) { set(cx - Math.round(k * 0.9), y0 - k, "w"); set(cx + 1 + Math.round(k * 0.9), y0 - k, "w"); }
    set(cx, y0 - 1, "m"); set(cx + 1, y0 - 1, "m");
  }
  // Screen: an inset plum line, then the dusk bands.
  const sx0 = x0 + bezel, sx1 = x1 - bezel, sy0 = y0 + bezel, sy1 = y1 - bezel - (S >= 32 ? Math.max(1, Math.round(A * 0.04)) : 0);
  const sh = sy1 - sy0 + 1, sw = sx1 - sx0 + 1;
  const horizon = sy0 + Math.round(sh * 0.56);
  const sunX = sx0 + Math.round(sw * 0.62), sunR = Math.max(1.2, sh * 0.2);
  for (let y = sy0; y <= sy1; y++) for (let x = sx0; x <= sx1; x++) {
    const edge = x === sx0 || x === sx1 || y === sy0 || y === sy1;
    if (edge) { set(x, y, "o"); continue; }
    const f = (y - sy0) / sh;
    let ch = f < 0.22 ? "L" : f < 0.36 ? "l" : y < horizon ? "P" : f < 0.78 ? "T" : f < 0.9 ? "t" : "N";
    if (y < horizon && Math.hypot(x + 0.5 - (sunX + 0.5), y + 0.5 - horizon) < sunR) ch = "S";
    // The sun's glitter on the sea: short mustard dashes on alternate rows, narrowing towards the viewer.
    if (y >= horizon && S >= 32 && (y - horizon) % 2 === 0 && Math.abs(x - sunX) < Math.max(1, sunR * (1 - (y - horizon) / (sy1 - horizon + 1)))) ch = "s";
    set(x, y, ch);
  }
  // Power light on the bezel's bottom-right.
  if (S >= 32) set(x1 - bezel, y1 - Math.max(1, Math.floor(bezel / 2)), "y");
  if (heads) {
    // Juno (left): the big cloud puff over a mustard hood. Kiki (right): a pink head with two buns over a lilac collar.
    const R = A * 0.15, base = S - pad - 1;
    const jx = pad + A * 0.3, jy = base - R * 0.95;
    const kx = pad + A * 0.7, ky = base - R * 0.8, kr = R * 0.8;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const px = x + 0.5, py = y + 0.5;
      if (py > base - R * 0.35 && py <= base && Math.abs(px - jx) < R * 1.25) set(x, y, "h");
      if (Math.hypot(px - jx, (py - jy) * 1.05) < R) set(x, y, "H");
      for (const a of [-160, -115, -65, -20]) {
        const t = (a * Math.PI) / 180;
        if (Math.hypot(px - jx - Math.cos(t) * R * 0.8, py - jy - Math.sin(t) * R * 0.8) < R * 0.42) set(x, y, "H");
      }
      if (py > base - kr * 0.35 && py <= base && Math.abs(px - kx) < kr * 1.25) set(x, y, "v");
      if (Math.hypot(px - kx, py - ky) < kr) set(x, y, "K");
      if (Math.hypot(px - kx - kr * 0.95, py - ky + kr * 0.85) < kr * 0.5) set(x, y, "K");
      if (Math.hypot(px - kx + kr * 0.95, py - ky + kr * 0.85) < kr * 0.5) set(x, y, "K");
    }
  }
  return g;
}

export interface StoreImage { file: string; w: number; h: number; pixels: Uint8Array; palette: readonly RGBA[] }

/** icon-16/32/48 at 1×; icon-128 = the 64 art px icon at 2× (Chrome asks for 96 px of art inside 16 px of margin). */
export function buildStoreIcons(): StoreImage[] {
  const out: StoreImage[] = [];
  for (const [S, pad, k] of [[16, 0, 1], [32, 0, 1], [48, 1, 1], [64, 8, 2]] as const) {
    const g = icon(S, pad);
    const img = render(g, ROLES);
    out.push({ file: `icon-${String(S * k)}.png`, w: S * k, h: S * k, pixels: k === 1 ? img : upscale(img, S, S, k), palette: PALETTE });
  }
  return out;
}
