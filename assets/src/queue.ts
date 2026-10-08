// Set (j) (OME-422), M6 queue panel: the "Up next" list (≤ 20 rows: what kind of source, the title, who added it, remove ×),
// the "Paste a video link" field, the empty state, and ADR 0024's synced-vs-not badge.
// Same palette, plum outline and top-left light as sets (c)/(e)/(f)/(h)/(i). Every motif keeps one meaning:
//   wood          = shared (set e): the queue is the room's, so its remove key is a little wood key.
//   tiny screen   = what kind of source a row is, never whose: a play mark (a video), the on-air dot (a live stream, rust like
//                   the LIVE pill) or a chain link on a dark screen (a pasted page that isn't synced). No third-party logos or colours.
//   in step       = two play marks one above the other, tied by a glow bar: everyone sees the same moment (synced tier).
//   out of step   = the same two marks staggered, no bar, in cream shade: everyone plays it on their own (generic tier).
//   ghost reels   = nothing queued: the room's projector with empty reel arms and dashed reels to load.
//   mini heads    = who added a row, at the size of a word: each avatar's silhouette cue (puff, beanie, brim, buns).
// No new colours: still the 67.
import { OUTLINE, colorIndex, type RampName, type Tone } from "./palette";
import { blank, render, stamp, type Grid, type RoleMap } from "./sprite";
import { all, lit, nine, slab, type UiFrame } from "./ui";

const c = (ramp: RampName, tone: Tone): number => colorIndex(ramp, tone);
const O = OUTLINE;

const ROLES: RoleMap = {
  i: { ramp: "cream", tone: 0 },
  C: { ramp: "cream", tone: 2 },
  y: { ramp: "mustard", tone: 0 },
  o: { ramp: "outline", tone: 1 },
  c: { ramp: "cream", hi: true },
  m: { ramp: "mustard", hi: true },
  w: { ramp: "wood", hi: true },
  W: { ramp: "wood", tone: 2 },
  x: { ramp: "charcoal", hi: true },
  // Screens: flat tones grouped with the wood bezel, so the bezel's auto shade rings the set, not the picture.
  n: { ramp: "night", tone: 2, group: "w" },
  N: { ramp: "night", tone: 1, group: "w" },
  X: { ramp: "charcoal", tone: 2, group: "w" },
  g: { ramp: "glow", tone: 0, group: "w" },
  G: { ramp: "glow", tone: 2, group: "w" },
  q: { ramp: "rust", tone: 0, group: "w" },
  Q: { ramp: "rust", tone: 2, group: "w" },
  k: { ramp: "cream", tone: 0, group: "w" },
  K: { ramp: "cream", tone: 2, group: "w" },
};

function grid(keyName: string, g: Grid, roles: RoleMap, ax: number, ay: number): UiFrame {
  return { key: keyName, w: g[0]?.length ?? 0, h: g.length, img: render(g, roles), ax, ay };
}

function art(keyName: string, rows: readonly string[], roles: RoleMap = ROLES, ax?: number, ay?: number): UiFrame {
  const w = rows[0]?.length ?? 0, h = rows.length;
  rows.forEach((r, i) => { if (r.length !== w) throw new Error(`${keyName}: row ${String(i)} is ${String(r.length)} wide, not ${String(w)}`); });
  const g = blank(w, h);
  stamp(g, rows, 0, 0);
  return grid(keyName, g, roles, ax ?? w / 2, ay ?? h / 2);
}

// ------------------------------------------------------------------ 9-slices

/** A queue row: a strip of dusk glass inside the panel (the room card's glass, without the wood rim, so 20 of them stay calm).
 *  hover = set (c)'s cream lit edge. next = the first row, "plays next": the TV's glow bar down its left side (set e's system line). */
function row(state: "idle" | "hover" | "next"): UiFrame {
  const W = 16;
  const img = slab(W, W, 2, (d, e) => {
    if (d === 0) return O;
    if (state === "next" && e === "l" && d <= 2) return c("glow", d === 1 ? 0 : 2);
    if (d === 1) return lit(e) ? (state === "hover" ? c("cream", 0) : c("night", 0)) : c("night", 2);
    return c("night", 1);
  });
  return nine(`queue/row/${state}`, W, W, img, all(4));
}

/** "Not synced" chip: set (e)'s chip with a flat cream-shade rim on charcoal instead of the TV's wood: it isn't the room's remote. */
function soloChip(): UiFrame {
  const W = 12;
  const img = slab(W, W, 2, (d) => {
    if (d === 0) return O;
    if (d === 1) return c("cream", 2);
    return c("charcoal", 2);
  });
  return nine("chip/solo", W, W, img, all(4));
}

/** Remove a row: a 12×12 wood key (shared: the queue is everyone's) with a cream ×. Same lip/hover/press recipe as set (c). */
const X_MARK = ["x...x", ".x.x.", "..x..", ".x.x.", "x...x"];
function removeKey(state: "idle" | "hover" | "press"): UiFrame {
  const W = 12, H = 12;
  const img = slab(W, H, 2, (d, e) => {
    if (d === 0) return O;
    if (state === "press") {
      if (d === 1 && e === "t") return O;
      if ((d === 1 && e === "l") || (d === 2 && e === "t")) return c("wood", 2);
      return c("wood", 1);
    }
    if (e === "b" && d <= 2) return c("wood", 2);
    if (d === 1 && e === "r") return c("wood", 2);
    if (d === 1 && lit(e)) return state === "hover" ? c("cream", 0) : c("wood", 0);
    return state === "hover" ? c("wood", 0) : c("wood", 1);
  });
  const dy = state === "press" ? 3 : 2;
  X_MARK.forEach((r, y) => { for (let x = 0; x < r.length; x++) if (r[x] === "x") img[(dy + y) * W + 4 + x] = c("cream", 0); });
  return { key: `qx/${state}`, w: W, h: H, img, ax: 0, ay: 0 };
}

// ------------------------------------------------------------------ icons, glyphs, source tiles, heads

const ICONS: Record<string, readonly string[]> = {
  // The queue: three rows, each a tiny screen and a title line. The top one plays next (glow).
  queue: [
    "................",
    "................",
    ".wwww...........",
    ".wggw.cccccccc..",
    ".wwww...........",
    "................",
    ".wwww...........",
    ".wnnw.cccccc....",
    ".wwww...........",
    "................",
    ".wwww...........",
    ".wnnw.ccccccccc.",
    ".wwww...........",
    "................",
    "................",
    "................",
  ],
  // Add to the queue: two rows and a mustard plus where the third would go.
  "queue-add": [
    "................",
    "................",
    ".wwww...........",
    ".wnnw.cccccccc..",
    ".wwww...........",
    "................",
    ".wwww...........",
    ".wnnw.cccccc....",
    ".wwww....mm.....",
    ".........mm.....",
    ".......mmmmmm...",
    ".......mmmmmm...",
    ".........mm.....",
    ".........mm.....",
    "................",
    "................",
  ],
};

/** Paste a link: two chain links, drawn as rings so the auto outline separates them. */
function linkIcon(): UiFrame {
  const g = blank(16, 16);
  const ringAt = (x0: number, y0: number, w: number, h: number, skip: (x: number, y: number) => boolean): void => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
      const edge = y === y0 || y === y0 + h - 1 || x === x0 || x === x0 + w - 1;
      const corner = (x === x0 || x === x0 + w - 1) && (y === y0 || y === y0 + h - 1);
      if (edge && !corner && !skip(x, y)) { const r = g[y]; if (r) r[x] = "c"; }
    }
  };
  // Left link, then the right one woven through it: it passes over the left link's right side at the top, under it at the bottom.
  ringAt(1, 4, 9, 6, () => false);
  ringAt(6, 6, 9, 6, (x, y) => x === 9 && y === 9);
  for (const [x, y] of [[9, 7]] as const) { const r = g[y]; if (r) r[x] = "."; }
  return grid("icon/link", g, ROLES, 8, 8);
}

const GLYPHS: Record<string, readonly string[]> = {
  // Synced: two seek bars with their heads at the same moment (glow fill, cream heads).
  insync: ["........", "....i...", ".gggiCC.", "........", "....i...", ".gggiCC.", "........", "........"],
  // Not synced: the same two bars with their heads at different moments, all in cream shade (no glow: the TV isn't driving it).
  outsync: ["........", ".....i..", ".CCCCiC.", "........", "..i.....", ".CiCCCC.", "........", "........"],
};

/** 14×12 source tiles: the row's kind of source, as a tiny wood-bezelled screen. Never a provider's logo or colour. */
const SOURCES: Record<string, readonly string[]> = {
  video: [
    "..............",
    ".wwwwwwwwwwww.",
    ".wnnnnnnnnnnw.",
    ".wnnnnngnnnnw.",
    ".wnnnnnggnnnw.",
    ".wnnnnngggnnw.",
    ".wnnnnnggnnnw.",
    ".wnnnnngnnnnw.",
    ".wnnnnnnnnnnw.",
    ".wwwwwwwwwwww.",
    "....ww..ww....",
    "..............",
  ],
  live: [
    "..............",
    ".wwwwwwwwwwww.",
    ".wnnnnnnnnnnw.",
    ".wnnKnnnnKnnw.",
    ".wnKnnqqnnKnw.",
    ".wnKnqqqqnKnw.",
    ".wnKnnqqnnKnw.",
    ".wnnKnnnnKnnw.",
    ".wnnnnnnnnnnw.",
    ".wwwwwwwwwwww.",
    "....ww..ww....",
    "..............",
  ],
  generic: [
    "..............",
    ".wwwwwwwwwwww.",
    ".wXXXXXXXXXXw.",
    ".wXXXXXXXXXXw.",
    ".wXkkkXXXXXXw.",
    ".wkXXkkkkXXXw.",
    ".wXkkkXXkXXXw.",
    ".wXXXXkkkXXXw.",
    ".wXXXXXXXXXXw.",
    ".wwwwwwwwwwww.",
    "....ww..ww....",
    "..............",
  ],
};

const face = (skin: RampName): RoleMap => ({ S: { ramp: skin, hi: true }, s: { ramp: skin, tone: 2, group: "S" }, o: { ramp: "outline", tone: 1, group: "S" } });

/** 12×13 mini heads for "added by": each avatar's set (a) silhouette cue at word size, facing the camera. */
const HEADS: Record<string, { roles: RoleMap; rows: readonly string[] }> = {
  juno: {
    roles: { ...face("skinDeep"), H: { ramp: "hairDark", hi: true }, x: { ramp: "charcoal", tone: 1 }, m: { ramp: "mustard", tone: 0 } },
    rows: [
      "............",
      "...HHHHHH...",
      "..HHHHHHHH..",
      ".HHHHHHHHHH.",
      ".HHHHHHHHHH.",
      ".HHSSSSSSHH.",
      ".HSSoSSoSSH.",
      "..SSSSSSSS..",
      "..SSSssSSS..",
      "..mSSSSSSm..",
      "..mxxxxxxm..",
      "............",
      "............",
    ],
  },
  pip: {
    roles: { ...face("skinLight"), T: { ramp: "teal", hi: true }, t: { ramp: "teal", tone: 0 }, P: { ramp: "cream", hi: true }, g: { ramp: "ginger", tone: 1 }, r: { ramp: "rust", tone: 2 } },
    rows: [
      "............",
      ".....PP.....",
      "....TTTT....",
      "...TTTTTT...",
      "..TTTTTTTT..",
      "..tttttttt..",
      "..gSSSSSSg..",
      "..rorSSror..",
      "..SSSSSSSS..",
      "..SSSssSSS..",
      "...SSSSSS...",
      "............",
      "............",
    ],
  },
  mo: {
    roles: { ...face("skinMedium"), v: { ramp: "olive", hi: true }, V: { ramp: "olive", tone: 2 }, b: { ramp: "hairDark", tone: 0 } },
    rows: [
      "............",
      "............",
      "....vvvv....",
      "...vvvvvv...",
      "...vvvvvv...",
      ".VVVVVVVVVV.",
      "..SSSSSSSS..",
      "..SSoSSoSS..",
      "..SSSSSSSS..",
      "..bSbbbbSb..",
      "...bbbbbb...",
      "............",
      "............",
    ],
  },
  kiki: {
    roles: { ...face("skinTan"), p: { ramp: "pink", hi: true }, B: { ramp: "blush", tone: 1, group: "S" } },
    rows: [
      "............",
      ".ppp....ppp.",
      ".ppp....ppp.",
      ".pppppppppp.",
      "..pppppppp..",
      "..pSSSSSSp..",
      "..SSoSSoSS..",
      "..SSSSSSSS..",
      "..SBSssSBS..",
      "...SSSSSS...",
      "............",
      "............",
      "............",
    ],
  },
};

// ------------------------------------------------------------------ the empty state (eager: every new room starts empty)

/** 48×32: the room's cream projector on its wood shelf, lens dark, its two reel arms empty and a dashed ghost reel on each. */
function emptyArt(): UiFrame {
  const W = 48, H = 32;
  const g = blank(W, H);
  const rect = (x: number, y: number, w: number, h: number, ch: string): void => {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) { const r = g[yy]; if (r && xx >= 0 && xx < W) r[xx] = ch; }
  };
  // Shelf.
  rect(3, 25, 42, 3, "w");
  rect(6, 28, 3, 2, "W"); rect(39, 28, 3, 2, "W");
  // Projector body, lens hood and a dark lens (nothing to show).
  rect(13, 15, 20, 10, "c");
  rect(33, 17, 4, 6, "x");
  rect(37, 18, 2, 4, "n");
  rect(15, 18, 6, 1, "C"); rect(15, 20, 6, 1, "C");
  // Two reel arms.
  rect(13, 11, 2, 4, "w");
  rect(31, 11, 2, 4, "w");
  // Ghost reels: dashed cream-shade rings round each hub, and the hubs themselves.
  for (const [cx, cy] of [[13, 8], [31, 8]] as const) {
    // A pixel ring (r 5 round a 2×2 hub), walked by angle and dashed 3 on / 2 off, so it reads as "a reel goes here".
    const ring: [number, number, number][] = [];
    for (let y = cy - 8; y <= cy + 9; y++) for (let x = cx - 8; x <= cx + 9; x++) {
      const dx = x - (cx + 0.5), dy = y - (cy + 0.5), dist = Math.hypot(dx, dy);
      if (dist >= 5.6 && dist < 6.6) ring.push([Math.atan2(dy, dx), x, y]);
    }
    ring.sort((p, q) => p[0] - q[0]);
    ring.forEach(([, x, y], n) => { const r = g[y]; if (n % 6 < 4 && r && x >= 0 && x < W && r[x] === ".") r[x] = "C"; });
    rect(cx, cy, 2, 2, "m");
  }
  return grid("queue/empty", g, ROLES, W / 2, H);
}

// ------------------------------------------------------------------ build + CSS

/** Up to 20 rows (the server's cap); the panel says "n / 20". */
export const QUEUE_MAX = 20;

export function buildQueueFrames(): UiFrame[] {
  const out: UiFrame[] = [];
  for (const s of ["idle", "hover", "next"] as const) out.push(row(s));
  out.push(soloChip());
  for (const s of ["idle", "hover", "press"] as const) out.push(removeKey(s));
  for (const [n, rows] of Object.entries(ICONS)) out.push(art(`icon/${n}`, rows, ROLES, 8, 8));
  out.push(linkIcon());
  for (const [n, rows] of Object.entries(GLYPHS)) out.push(art(`glyph/${n}`, rows, ROLES, 4, 4));
  for (const [n, rows] of Object.entries(SOURCES)) out.push(art(`qsrc/${n}`, rows, ROLES, 7, 6));
  for (const [n, h] of Object.entries(HEADS)) out.push(art(`head/${n}`, h.rows, h.roles, 6, 6));
  out.push(emptyArt());
  return out;
}

const u = (n: number): string => (n === 0 ? "0" : `calc(${String(n)} * var(--ui-px))`);

/** Set (j) queue rules appended to `ui/reference.css`. */
export function queueCss(rects: Readonly<Record<string, { x: number; y: number; w: number; h: number }>>): string {
  const slice = (k: string): string => `url("slices/${k.replace(/\//g, "-")}.png")`;
  const nineRule = (k: string, b: number): string =>
    `border-style: solid; border-color: transparent; border-width: ${u(b)}; border-image: ${slice(k)} ${String(b)} fill / ${u(b)} stretch;`;
  const src = (k: string): string => `border-image-source: ${slice(k)};`;
  const kebab = (k: string): string => k.replace(/\//g, "-");
  const rect = (k: string): { x: number; y: number; w: number; h: number } => {
    const r = rects[k];
    if (!r) throw new Error(`missing ${k}`);
    return r;
  };
  const sprite = (k: string): string => { const r = rect(k); return `.ui-${kebab(k)} { width: ${u(r.w)}; height: ${u(r.h)}; background-position: ${u(-r.x)} ${u(-r.y)}; }`; };
  const pos = (k: string): string => { const r = rect(k); return `background-position: ${u(-r.x)} ${u(-r.y)};`; };
  const sprites = Object.keys(rects).filter((k) => /^(qsrc|head)\//.test(k) || k === "queue/empty").sort();
  return `
/* ---- Set (j) (OME-422): the queue. Wood = shared (the queue is the room's). A tiny screen = the kind of source, never the provider:
 * play mark = a video, rust on-air dot = a live stream, chain link on a dark screen = a pasted page that isn't synced. Synced vs not
 * (ADR 0024) is a chip with two play marks in step (wood rim, "Synced") or out of step (cream-shade rim, "Not synced"), always in words. */
.ui-queue, .ui-qrow, .ui-qx { image-rendering: pixelated; box-sizing: border-box; }
${sprites.map(sprite).join("\n")}

/* The panel: <section class="ui-panel ui-queue" aria-label="Up next">. Head: icon/queue + "Up next" + the count "3 / ${String(QUEUE_MAX)}".
 * Then <ol class="ui-qlist">, then the paste row: .ui-input with icon/link before it + the primary "Add" key (icon/queue-add). */
.ui-queue { display: grid; grid-template-columns: minmax(0, 1fr); gap: ${u(3)}; }
.ui-qlist { list-style: none; margin: 0; padding: 0; display: grid; gap: ${u(1)}; max-height: calc(8 * ${u(26)}); overflow-y: auto; }
/* A row: <li class="ui-qrow"> qsrc tile · the title (one line, ellipsis) over "head/<avatar> Kit" · the synced chip · the × key.
 * The first row is .is-next ("plays next": the glow bar). Hover lights the edge; the × only shows for the host and whoever added it. */
.ui-qrow { ${nineRule("queue/row/idle", 4)} display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; align-items: center; gap: ${u(4)}; min-height: ${u(24)}; padding: ${u(1)} ${u(2)}; color: var(--ui-text); }
.ui-qrow:hover, .ui-qrow.is-hover, .ui-qrow:focus-within { ${src("queue/row/hover")} }
.ui-qrow.is-next { ${src("queue/row/next")} }
.ui-qrow .body { display: grid; gap: ${u(1)}; min-width: 0; }
.ui-qrow .title { font-size: 13px; font-weight: 700; line-height: 1.2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; display: block; }
.ui-qrow .meta { display: flex; align-items: center; gap: ${u(2)}; font-size: 11px; font-weight: 500; line-height: 1.2; color: var(--ui-muted); white-space: nowrap; }
.ui-qrow .ui-chip { font-size: 10px; }
/* Remove ×: <button class="ui-sprite ui-qx" aria-label="Remove <title> from the queue">. 12 art px, wood. */
.ui-qx { width: ${u(12)}; height: ${u(12)}; padding: 0; border: 0; cursor: pointer; ${pos("qx/idle")} }
.ui-qx:hover, .ui-qx.is-hover { ${pos("qx/hover")} }
.ui-qx:active, .ui-qx.is-press { ${pos("qx/press")} }
.ui-qx:focus-visible, .ui-qx.is-focus { outline: var(--ui-px) solid var(--ui-text); outline-offset: var(--ui-px); }

/* Synced vs not (ADR 0024): .ui-chip (wood rim) + glyph/insync + "Synced" · .ui-chip.solo + glyph/outsync + "Not synced". */
.ui-chip.solo { ${src("chip/solo")} color: var(--ui-disabled-text); }

/* Empty: queue/empty (the projector with no reels) + one line, centred where the list would be. */
.ui-qempty { display: grid; justify-items: center; gap: ${u(2)}; padding: ${u(4)} 0; font-size: 13px; font-weight: 500; color: var(--ui-muted); text-align: center; }
`;
}
