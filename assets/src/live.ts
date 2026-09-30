// M2 additions to set (e) (OME-120): the live transport (Twitch live), the seek-only hint, and the provider plate.
// Same materials rule as set (e): wood = shared (everyone), mustard rim on night = only you, TV glow = the video.
// Two new materials, each with one job:
//   rust    = "on air": the LIVE pill is a status light, never a control (you can't click the broadcast).
//   brass   = the TV's own nameplate: which kind of source is on. Plain system-font text + a generic engraved glyph;
//             never a provider's logo, colour or lettering.
// The quiet charcoal hint says "this source can only jump to stay in sync" without shouting.
import { OUTLINE, colorIndex, type RampName, type Tone } from "./palette";
import { blank, render, stamp, type RoleMap } from "./sprite";
import { all, lit, nine, slab, type UiFrame } from "./ui";

const c = (ramp: RampName, tone: Tone): number => colorIndex(ramp, tone);
const O = OUTLINE;

/** 12×12 pill/chip, same chamfer and slices as `chip/*`. */
function pill(keyName: string, rim: RampName, rimHi: Tone, rimLo: Tone, fill: number): UiFrame {
  const W = 12;
  const img = slab(W, W, 2, (d, e) => {
    if (d === 0) return O;
    if (d === 1) return c(rim, lit(e) ? rimHi : rimLo);
    return fill;
  });
  return nine(keyName, W, W, img, all(4));
}

/** Brass nameplate with four rivets in its corner slices: the TV's "what's on" plate. */
function plate(): UiFrame {
  const W = 12;
  const img = slab(W, W, 2, (d, e) => {
    if (d === 0) return O;
    if (d === 1) return lit(e) ? c("mustard", 0) : c("mustard", 2);
    return c("mustard", 1);
  });
  // Rivets: a wood-shade dot in each corner slice, inside the rim, so the middle bands stay flat.
  for (const [x, y] of [[3, 3], [W - 4, 3], [3, W - 4], [W - 4, W - 4]] as const) img[y * W + x] = c("wood", 2);
  return nine("plate/source", W, W, img, all(4));
}

const ROLES: RoleMap = {
  i: { ramp: "cream", tone: 0 },
  C: { ramp: "cream", tone: 2 },
  R: { ramp: "rust", tone: 0 },
  x: { ramp: "charcoal", tone: 0 },
  g: { ramp: "glow", hi: true },
  // Resync sticker's speed dash.
  G: { ramp: "glow", tone: 0 },
};

function art(keyName: string, rows: readonly string[], ax: number, ay: number): UiFrame {
  const w = rows[0]?.length ?? 0;
  const g = blank(w, rows.length);
  stamp(g, rows, 0, 0);
  return { key: keyName, w, h: rows.length, img: render(g, ROLES), ax, ay };
}

/** Engraved into the brass: plum lines with a 1 px mustard-highlight lip below/right, no outline ring. */
function engraved(keyName: string, rows: readonly string[]): UiFrame {
  const w = rows[0]?.length ?? 0, h = rows.length;
  const img = new Uint8Array(w * h);
  const cut = (x: number, y: number): boolean => rows[y]?.charAt(x) === "o";
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (cut(x, y)) img[y * w + x] = O;
      else if (cut(x - 1, y - 1) || (cut(x, y - 1) && !cut(x - 1, y))) img[y * w + x] = c("mustard", 0);
    }
  }
  return { key: keyName, w, h, img, ax: w / 2, ay: h / 2 };
}

// Back to live: play's 2:1 stair running into a bar ("to the end"). Flat highlight like the other key icons.
const TO_LIVE: readonly string[] = [
  "................",
  "................",
  "................",
  "...........ii...",
  "..ii.......ii...",
  "..iiii.....ii...",
  "..iiiiii...ii...",
  "..iiiiiiii.ii...",
  "..iiiiiiii.ii...",
  "..iiiiii...ii...",
  "..iiii.....ii...",
  "..ii.......ii...",
  "...........ii...",
  "................",
  "................",
  "................",
];

// 8×8 one-line glyphs (6×6 art + outline), like set (e)'s.
const GLYPHS: Record<string, readonly string[]> = {
  // On-air lamp, 2-frame blink: cream ↔ rust highlight, on the pill's dark rust.
  "onair/0": ["........", "..iiii..", ".iiiiii.", ".iiiiii.", ".iiiiii.", ".iiiiii.", "..iiii..", "........"],
  "onair/1": ["........", "..RRRR..", ".RRRRRR.", ".RRRRRR.", ".RRRRRR.", ".RRRRRR.", "..RRRR..", "........"],
  // Lamp off (paused / behind live): a charcoal ring round a plum centre.
  "onair-off": ["........", "..xxxx..", ".xx..xx.", ".x....x.", ".x....x.", ".xx..xx.", "..xxxx..", "........"],
  // Seek-only: a staircase instead of a smooth ramp. "This source keeps up in steps."
  hop: ["........", ".....gg.", ".....gg.", "...gggg.", "...gggg.", ".gggggg.", ".gggggg.", "........"],
};

// Engraved source glyphs for the brass plate (8×8). Generic kinds of source, never a provider's mark.
const SOURCE: Record<string, readonly string[]> = {
  // A screen with a play mark: on-demand video.
  video: ["........", "ooooooo.", "o.o...o.", "o.oo..o.", "o.o...o.", "ooooooo.", "........", "........"],
  // A plain broadcast dot, the on-air lamp cut into brass: a live stream. (OME-137: the old ((•)) read as goggles.)
  live: ["........", "..ooo...", ".ooooo..", ".ooooo..", ".ooooo..", "..ooo...", "........", "........"],
};

// Resync, one-shot on a name tag: a glow double chevron (the seek glyph, sticker-sized) slides right and lands.
// Seek-only providers catch up by jumping ahead, not by speeding up. 16×16 stickers, centred (anchor (8, 8)) so they sit level with the tag text.
const CHEVRON: readonly string[] = ["gg...gg...", ".gg...gg..", "..gg...gg.", "..gg...gg.", ".gg...gg..", "gg...gg..."];
const RESYNC: readonly (readonly string[])[] = [0, 1, 2].map((n) => {
  // Frame 0 sits left, frame 1 mid-slide with a speed dash behind it, frame 2 landed right.
  const x = n * 2;
  return CHEVRON.map((r, y) => {
    const dash = n === 1 && (y === 2 || y === 3) ? "G." : "..";
    return (n === 1 ? dash : "..") + ".".repeat(x) + r + ".".repeat(4 - x);
  });
});

function resync(n: number): UiFrame {
  const src = RESYNC[n];
  if (!src) throw new Error(`no resync frame ${String(n)}`);
  const w = src[0]?.length ?? 0;
  const g = blank(16, 16);
  stamp(g, src, Math.floor((16 - w) / 2), Math.floor((16 - src.length) / 2));
  return { key: `resync/${String(n)}`, w: 16, h: 16, img: render(g, ROLES), ax: 8, ay: 8 };
}

export function buildLiveFrames(): UiFrame[] {
  const out: UiFrame[] = [
    // On air: bright rim, dark rust fill (cream text on it is 7.5:1).
    pill("pill/live", "rust", 0, 1, c("rust", 2)),
    // Paused / behind live: the same pill with the light off. Dim rust rim, charcoal fill, lilac text.
    pill("pill/behind", "rust", 2, 2, c("charcoal", 2)),
    // Seek-only hint: charcoal on charcoal, the quietest chip there is.
    pill("chip/hint", "charcoal", 0, 1, c("charcoal", 2)),
    plate(),
    art("icon/tolive", TO_LIVE, 8, 8),
    art("icon/tolive-off", TO_LIVE.map((r) => r.replace(/i/g, "C")), 8, 8),
  ];
  for (const [name, rows] of Object.entries(GLYPHS)) out.push(art(`glyph/${name}`, rows, 4, 4));
  for (const [name, rows] of Object.entries(SOURCE)) out.push(engraved(`glyph/src-${name}`, rows));
  for (let n = 0; n < RESYNC.length; n++) out.push(resync(n));
  return out;
}

/** On-air lamp blink (ms per frame, `glyph/onair/0..1`). Slow, so it glows rather than flashes. */
export const ONAIR_FRAME_MS = 700;
/** Resync, one-shot: `resync/0..2`. */
export const RESYNC_FRAME_MS = [160, 200, 640] as const;

const u = (n: number): string => (n === 0 ? "0" : `calc(${String(n)} * var(--ui-px))`);

/** Live / seek-only / provider rules appended to `ui/reference.css`. */
export function liveCss(rects: Readonly<Record<string, { x: number; y: number }>>): string {
  const at = (k: string): string => {
    const r = rects[k];
    if (!r) throw new Error(`missing ${k}`);
    return `${u(-r.x)} ${u(-r.y)}`;
  };
  const slice = (k: string): string => `url("slices/${k.replace(/\//g, "-")}.png")`;
  const nineRule = (k: string): string =>
    `border-style: solid; border-color: transparent; border-width: ${u(4)}; border-image: ${slice(k)} 4 fill / ${u(4)} stretch;`;
  const total = RESYNC_FRAME_MS.reduce((a, b) => a + b, 0);
  const p1 = Math.round((RESYNC_FRAME_MS[0] / total) * 100);
  const p2 = Math.round(((RESYNC_FRAME_MS[0] + RESYNC_FRAME_MS[1]) / total) * 100);
  return `
/* ---- M2 (OME-120): live transport, seek-only hint, provider plate. ----
 * Rust = on air (a status light, never a control). Brass = the TV's nameplate (plain text + a generic glyph, never a
 * provider's logo, colour or lettering). The back-to-live key is wood: jumping to live changes the video for everyone. */
.ui-live, .ui-hint, .ui-plate { image-rendering: pixelated; box-sizing: border-box; display: inline-flex; align-items: center; gap: ${u(2)}; padding: 0 ${u(1)}; line-height: 1; white-space: nowrap; flex: none; }

/* LIVE pill. Put a .ui-sprite.ui-onair inside, before the word. .is-behind = paused or not at the live edge. */
.ui-live { ${nineRule("pill/live")} color: var(--ui-text); font-size: 11px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
.ui-onair { --f0: ${at("glyph/onair/0")}; --f1: ${at("glyph/onair/1")}; width: ${u(8)}; height: ${u(8)}; background-position: var(--f0); animation: ui-onair ${String(ONAIR_FRAME_MS * 2)}ms steps(1) infinite; }
@keyframes ui-onair { 0% { background-position: var(--f0); } 50% { background-position: var(--f1); } }
.ui-live.is-behind { border-image-source: ${slice("pill/behind")}; color: var(--ui-muted); }
.ui-live.is-behind .ui-onair { animation: none; background-position: ${at("glyph/onair-off")}; }
/* How far behind live the room is: a normal .ui-readout with .behind ("−0:42"). Hide it at the live edge. */
.ui-readout.behind { color: var(--ui-muted); }
/* Back to live: a wood .ui-button.shared.icon (it moves everyone). Disabled at the live edge. */
.ui-button:disabled .ui-icon-tolive, .ui-button.is-disabled .ui-icon-tolive { background-position: ${at("icon/tolive-off")}; }
/* Where the scrubber was: one muted line saying why there is none. Drop it first when space runs out. */
.ui-live-note { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ui-muted); font-size: 12px; font-weight: 500; }
.ui-room .ui-live, .ui-room .ui-hint { font-size: 9px; }
.ui-room .ui-plate { font-size: 10px; }
.ui-room .ui-live-note { font-size: 11px; }

/* Seek-only hint: the provider can't nudge its speed, so drift is fixed by small jumps. Quiet on purpose. */
.ui-hint { ${nineRule("chip/hint")} color: var(--ui-muted); font-size: 11px; font-weight: 600; }

/* Provider plate: brass, plum system-font text (8:1). The name is plain text, e.g. "YouTube", "Twitch", "Vimeo". */
.ui-plate { ${nineRule("plate/source")} color: var(--ui-on-primary); font-size: 11px; font-weight: 700; }

/* Narrow shelf (.compact): keep the lamp, the pill word, the glyphs; drop the note and the plate/hint words. */
.ui-tv-shelf.compact .ui-live-note, .ui-tv-shelf.compact .ui-plate-name, .ui-tv-shelf.compact .ui-hint-text { display: none; }
/* At 1× (.ui-room) the hint is glyph-only by default: its words would be the smallest text on the shelf. They stay in the
 * DOM for screen readers (visually hidden, not display: none); the chip's title spells it out on hover. Opt back in with .wordy. */
.ui-room .ui-hint:not(.wordy) .ui-hint-text { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }

/* Resync, one-shot on a tag: add .resynced when a seek-only viewer was jumped back into sync, remove after ${String(total)} ms.
 * Hangs off the tag's left end: the sticker moves 1 art px further left (translate -1), and its art leaves 1 empty column on the
 * right, so the visible gap is 2 art px (4 screen px at 2×). The landed chevrons nearly reach the sticker's right edge, so unlike the
 * centred hourglass it must not overlap the tag (OME-137: it ran into the name). */
.ui-resync { --f0: ${at("resync/0")}; --f1: ${at("resync/1")}; --f2: ${at("resync/2")}; width: ${u(16)}; height: ${u(16)}; background-position: var(--f2); animation: ui-resync ${String(total)}ms steps(1) 1 both; }
@keyframes ui-resync { 0% { background-position: var(--f0); } ${String(p1)}% { background-position: var(--f1); } ${String(p2)}% { background-position: var(--f2); } 100% { background-position: var(--f2); } }
.ui-tag.resynced .ui-resync { position: absolute; right: 100%; top: 50%; translate: ${u(-1)} -50%; }
@media (prefers-reduced-motion: reduce) { .ui-onair, .ui-resync { animation: none; } }
`;
}
