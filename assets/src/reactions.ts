// Movie night (OME-1641): reaction glyphs, the moments strip's icons and the recap card chrome. Same palette, plum outline and
// top-left light as every other set. One meaning per motif:
//   a glyph that rises and dithers out = somebody reacted, just now. It is the emote sticker's little brother: heart, laugh and
//                     clap are the motion atlas's own sticker pixels (so a reaction and an emote read as one family); wow is new.
//   a 9 px mini       = the same reaction, remembered: pips on the moments strip and counts on the recap card.
//   the dusk bands    = the share card's (set m) title screen: the recap card is the film's own end card.
// No new colours: still the 67. Fading is 1-bit dither (sets i and k), never alpha, so the sheet stays PNG-8.
import { EMOTES, type EmoteDef } from "./motion";
import { RAMPS, type RampName } from "./palette";
import { blank, render, stamp, type RoleMap } from "./sprite";
import type { UiFrame } from "./ui";

/** One glyph cell. The glyph rises inside it, so a burst is frame swaps only: no per-frame position tween. */
export const GLYPH_CELL = { w: 16, h: 28 } as const;
/** Anchor: bottom centre = where the glyph starts, just above the sender's name tag. */
const ANCHOR = { x: 8, y: 27 } as const;
/** Mini icons: 7 art px of art + outline. 18 CSS px in page chrome (--ui-px 2px), 9 px in the room. */
export const MINI = 9;

interface ReactionDef {
  id: "heart" | "laugh" | "wow" | "clap";
  label: string;
  roles: RoleMap;
  pop: readonly string[];
  art: readonly string[];
  accent: readonly string[];
  mini: readonly string[];
}

const sticker = (id: string): EmoteDef => {
  const e = EMOTES.find((x) => x.id === id);
  if (!e) throw new Error(`no emote ${id}`);
  return e;
};
const fromSticker = (id: "heart" | "laugh" | "clap", label: string, mini: readonly string[]): ReactionDef => {
  const e = sticker(id);
  return { id, label, roles: e.roles, pop: e.pop, art: e.art, accent: e.accent, mini };
};

/** Wow: a teal starburst with a gasp. Spiky where laugh is round, teal where laugh is mustard, so the two faces never merge. */
const WOW: ReactionDef = {
  id: "wow",
  label: "Wow",
  roles: { W: { ramp: "teal", hi: true, group: "W" }, E: { ramp: "outline", tone: 1, group: "W" }, M: { ramp: "night", tone: 2, group: "W" } },
  pop: ["....W....", ".W.WWW.W.", "..WWWWW..", ".WEWWWEW.", "WWEWWWEWW", ".WWWEWWW.", "..WWWWW..", ".W.WWW.W.", "....W...."],
  art: [
    ".....W.....",
    ".W..WWW..W.",
    "..WWWWWWW..",
    "..WWWWWWW..",
    ".WWEWWWEWW.",
    "WWWEWWWEWWW",
    ".WWWWEWWWW.",
    "..WWEMEWW..",
    "..WWWEWWW..",
    ".W..WWW..W.",
    ".....W.....",
  ],
  // The jolt: spikes shoot up and down, eyes go tall, the gasp opens wider.
  accent: [
    ".....W.....",
    ".....W.....",
    ".W..WWW..W.",
    "..WWWWWWW..",
    "..WEWWWEW..",
    ".WWEWWWEWW.",
    "WWWEWWWEWWW",
    ".WWWWEWWWW.",
    "..WWEMEWW..",
    "..WWEMEWW..",
    "..WWWEWWW..",
    ".W..WWW..W.",
    ".....W.....",
  ],
  mini: ["...W...", "..WWW..", ".WEWEW.", "WWWWWWW", ".WWEWW.", "..WWW..", "...W..."],
};

export const REACTIONS: readonly ReactionDef[] = [
  fromSticker("heart", "Heart", [".HH.HH.", "HwHHHHH", "HHHHHHH", ".HHHHH.", "..HHH..", "...H..."]),
  fromSticker("laugh", "Laugh", ["..YYY..", ".YYYYY.", "YEYYYEY", "YYYYYYY", "YEEEEEY", ".YEdEY.", "..YYY.."]),
  WOW,
  fromSticker("clap", "Clap", ["...y...", "hh...hh", "hhh.hhh", ".hh.hh.", ".hh.hh.", "..c.c.."]),
];

/** [art, rise in px, ms, dither]. dither: 0 = solid, 2 = every other pixel, 4 = one in four. Total 820 ms. */
type Step = readonly ["pop" | "art" | "accent", number, number, 0 | 2 | 4];
export const REACTION_SEQUENCE: readonly Step[] = [
  ["pop", 0, 80, 0],
  ["art", 2, 120, 0],
  ["accent", 4, 200, 0],
  ["art", 6, 180, 0],
  ["art", 8, 120, 2],
  ["art", 10, 120, 4],
];

/** The strip's own icons. `top`: a mustard star for the recap's top moments. `catchup`: cream fast-forward for "Catch me up". */
const STRIP_ICONS: readonly { id: string; roles: RoleMap; rows: readonly string[] }[] = [
  { id: "top", roles: { S: { ramp: "mustard", hi: true } }, rows: ["...S...", "..SSS..", "SSSSSSS", ".SSSSS.", "..SSS..", ".SS.SS.", ".S...S."] },
  { id: "catchup", roles: { c: { ramp: "cream", hi: true } }, rows: ["c...c..", "cc..cc.", "ccc.ccc", "cc..cc.", "c...c.."] },
];

function dither(img: Uint8Array, w: number, step: 0 | 2 | 4): Uint8Array {
  if (step === 0) return img;
  return img.map((v, i) => {
    const x = i % w, y = Math.floor(i / w);
    const keep = step === 2 ? (x + y) % 2 === 0 : x % 2 === 0 && y % 2 === 0;
    return keep ? v : 0;
  });
}

function glyph(r: ReactionDef, [art, rise, , d]: Step): Uint8Array {
  const rows = r[art];
  const w = Math.max(...rows.map((s) => s.length));
  const g = blank(GLYPH_CELL.w, GLYPH_CELL.h);
  // Bottom outline row lands on 26 - rise.
  stamp(g, rows, Math.floor((GLYPH_CELL.w - w) / 2), 26 - rise - rows.length);
  return dither(render(g, r.roles), GLYPH_CELL.w, d);
}

function mini(id: string, roles: RoleMap, rows: readonly string[]): UiFrame {
  const g = blank(MINI, MINI);
  stamp(g, rows, 1, 1 + Math.floor((7 - rows.length) / 2));
  return { key: `moments/${id}`, w: MINI, h: MINI, img: render(g, roles), ax: (MINI - 1) / 2, ay: (MINI - 1) / 2 };
}

/** react/<id>/<0..5> (room scale, 16×28) + moments/<id> minis (9×9). */
export function buildReactionFrames(): UiFrame[] {
  const glyphs = REACTIONS.flatMap((r) =>
    REACTION_SEQUENCE.map((s, n): UiFrame => ({ key: `react/${r.id}/${String(n)}`, w: GLYPH_CELL.w, h: GLYPH_CELL.h, img: glyph(r, s), ax: ANCHOR.x, ay: ANCHOR.y })),
  );
  const minis = [...REACTIONS.map((r) => mini(r.id, r.roles, r.mini)), ...STRIP_ICONS.map((s) => mini(s.id, s.roles, s.rows))];
  return [...glyphs, ...minis];
}

/** Fixed layout, so the CSS and the atlas agree without a packer: one glyph per row, frames left to right, minis in the right column. */
export const SHEET = { w: 128, h: 128 } as const;
export function layout(frames: readonly UiFrame[]): Map<string, { x: number; y: number }> {
  const at = new Map<string, { x: number; y: number }>();
  let m = 0;
  for (const f of frames) {
    const k = /^react\/(\w+)\/(\d)$/.exec(f.key);
    if (k) at.set(f.key, { x: Number(k[2]) * GLYPH_CELL.w, y: REACTIONS.findIndex((r) => r.id === k[1]) * GLYPH_CELL.h });
    else at.set(f.key, { x: 6 * GLYPH_CELL.w + 1, y: 1 + 10 * m++ });
  }
  return at;
}

/** Pixi atlas extras: the one-shot burst and its per-frame ms. */
export function reactionAnims(): { animations: Record<string, string[]>; omega: Record<string, unknown> } {
  const animations = Object.fromEntries(REACTIONS.map((r) => [`react/${r.id}`, REACTION_SEQUENCE.map((_, n) => `react/${r.id}/${String(n)}`)]));
  return {
    animations,
    omega: {
      license: "CC-BY-SA-4.0",
      reactions: REACTIONS.map((r) => ({ id: r.id, label: r.label })),
      ms: REACTION_SEQUENCE.map(([, , ms]) => ms),
      loop: false,
      maxLive: 12,
    },
  };
}

// ------------------------------------------------------------------ recap card + lights-down (DOM chrome)

const hex = (ramp: RampName, tone: 0 | 1 | 2): string => RAMPS[ramp][tone];
/** Every text colour the recap card puts on a background. The test holds each at WCAG AA (4.5:1). */
export const RECAP_TEXT: readonly { use: string; fg: string; bg: string }[] = [
  { use: "title on the screen's night band", fg: hex("cream", 0), bg: hex("night", 2) },
  { use: "\"The end\" kicker on the night band", fg: hex("mustard", 1), bg: hex("night", 2) },
  { use: "section labels on the panel", fg: hex("lilac", 0), bg: hex("charcoal", 2) },
  { use: "counts and body text on the panel", fg: hex("cream", 0), bg: hex("charcoal", 2) },
  { use: "moment time on its well", fg: hex("mustard", 0), bg: hex("night", 2) },
  { use: "moment counts on its well", fg: hex("cream", 0), bg: hex("night", 2) },
  { use: "moment row, hover", fg: hex("cream", 0), bg: hex("night", 1) },
];

/** WCAG 2.x contrast ratio of two #rrggbb colours. */
export function contrast(a: string, b: string): number {
  const lum = (h: string): number => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = Number.parseInt(h.slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (bl ?? 0);
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

/** `ui/moments.css`: lazy, loaded with the strip or the recap card. Sprites come from `reactions.png`, scaled by --ui-px. */
export function momentsCss(at: ReadonlyMap<string, { x: number; y: number }>): string {
  const u = (n: number): string => `calc(${String(n)} * var(--ui-px))`;
  const pos = (k: string, dy = 0): string => {
    const p = at.get(k);
    if (!p) throw new Error(`no rect ${k}`);
    return `${u(-p.x)} ${u(-(p.y + dy))}`;
  };
  const minis = [...REACTIONS.map((r) => r.id), ...STRIP_ICONS.map((s) => s.id)].map((id) => `.ui-mini-${id} { background-position: ${pos(`moments/${id}`)}; }`).join("\n");
  // The settled frame (react/<id>/1, rise 2) cropped to its 16×16 glyph box: the reaction bar's keys.
  const keys = REACTIONS.map((r) => `.ui-react-${r.id} { background-position: ${pos(`react/${r.id}/1`, 10)}; }`).join("\n");
  const n2 = hex("night", 2), n1 = hex("night", 1);
  return `/* omega-share Movie night chrome (OME-1641). GENERATED by assets/src/build.ts. Lazy; needs reference.css. Spec: assets/README.md § Movie night. CC BY-SA 4.0. */
.ui-mini, .ui-react { display: inline-block; flex: none; image-rendering: pixelated; background: url("reactions.png") no-repeat; background-size: ${u(128)} ${u(128)}; }
.ui-mini { width: ${u(MINI)}; height: ${u(MINI)}; }
${minis}
.ui-react { width: ${u(16)}; height: ${u(16)}; }
${keys}

.ui-moments { position: relative; height: ${u(14)}; margin-top: ${u(2)}; }
.ui-moments-bars { position: absolute; inset: auto 0 0 0; height: ${u(5)}; display: flex; align-items: flex-end; gap: var(--ui-px); padding: var(--ui-px); background: ${n2}; box-shadow: 0 0 0 var(--ui-px) var(--ui-page); }
.ui-moments-bars > i { flex: 1; height: calc(var(--h) * 100%); min-height: var(--ui-px); background: var(--ui-accent); }
.ui-moment-pip { position: absolute; bottom: ${u(6)}; left: calc(var(--at) * 100%); translate: -50% 0; width: ${u(11)}; height: ${u(11)}; padding: 0; display: grid; place-items: center; background: ${n2}; border: var(--ui-px) solid ${hex("night", 0)}; border-radius: 50%; cursor: pointer; box-shadow: 0 0 0 var(--ui-px) var(--ui-page); }
.ui-moment-pip:hover, .ui-moment-pip.is-hover { background: ${n1}; border-color: var(--ui-text); }
.ui-moment-pip:focus-visible { outline: var(--ui-px) solid var(--ui-text); outline-offset: var(--ui-px); }
.ui-moment-pip:disabled { cursor: default; }

.ui-recap { inline-size: min(360px, 100%); display: grid; gap: ${u(4)}; position: relative; }
.ui-recap-screen { margin: ${u(-2)} ${u(-2)} 0; display: grid; grid-template-columns: minmax(0, 1fr) auto; column-gap: ${u(3)}; align-items: start; padding: ${u(4)} ${u(4)} ${u(14)} ${u(5)}; border: var(--ui-px) solid var(--ui-page);
  background: linear-gradient(to top, ${hex("teal", 2)} 0 ${u(2)}, ${hex("teal", 1)} 0 ${u(5)}, ${hex("mustard", 1)} 0 ${u(6)}, ${hex("pink", 1)} 0 ${u(8)}, ${hex("lilac", 1)} 0 ${u(10)}, ${n1} 0 ${u(13)}, ${n2} 0); }
.ui-recap-kicker, .ui-recap-title { grid-column: 1; }
.ui-recap-kicker { color: ${hex("mustard", 1)}; font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: lowercase; }
.ui-recap-title { color: ${hex("cream", 0)}; font-size: 16px; font-weight: 700; line-height: 1.25; margin: ${u(1)} 0 0; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.ui-recap-label { color: var(--ui-muted); font-size: 12px; font-weight: 700; margin: 0 0 ${u(2)}; }
.ui-recap-who { display: flex; flex-wrap: wrap; gap: ${u(2)}; list-style: none; margin: 0; padding: 0; }
.ui-recap-moments { display: grid; gap: ${u(2)}; list-style: none; margin: 0; padding: 0; }
.ui-recap-moment { display: grid; grid-template-columns: auto auto 1fr; align-items: center; gap: ${u(3)}; width: 100%; padding: ${u(2)} ${u(3)}; background: ${n2}; border: var(--ui-px) solid var(--ui-page); color: var(--ui-text); font: inherit; font-size: 13px; text-align: start; cursor: pointer; }
.ui-recap-moment:hover, .ui-recap-moment.is-hover { background: ${n1}; border-color: var(--ui-accent); }
.ui-recap-moment:focus-visible { outline: var(--ui-px) solid var(--ui-text); outline-offset: var(--ui-px); }
.ui-recap-moment time { color: ${hex("mustard", 0)}; font-variant-numeric: tabular-nums; font-weight: 700; }
.ui-recap-counts { display: flex; flex-wrap: wrap; gap: ${u(4)}; align-items: center; color: var(--ui-text); font-size: 13px; font-variant-numeric: tabular-nums; }
.ui-recap-counts > span { display: inline-flex; align-items: center; gap: ${u(1)}; }
.ui-recap-close { grid-column: 2; grid-row: 1 / span 2; }

.ui-lights-down { position: absolute; inset: 0; pointer-events: none; opacity: 0; transition: opacity 900ms steps(6);
  background: radial-gradient(ellipse 70% 62% at var(--ui-screen-x, 50%) var(--ui-screen-y, 30%),
    color-mix(in srgb, var(--ui-screen-tint, ${hex("glow", 1)}) 16%, transparent) 0 30%,
    color-mix(in srgb, var(--ui-screen-tint, ${hex("glow", 1)}) 8%, rgb(43 29 47 / .3)) 30% 48%,
    rgb(43 29 47 / .5) 48% 68%, rgb(43 29 47 / .66) 68%); }
.ui-lights-down.is-on { opacity: 1; }
@media (prefers-reduced-motion: reduce) { .ui-lights-down { transition: none; } }
`;
}
