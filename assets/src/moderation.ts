// Set (j) (OME-422), M6 house rules: the owner's moderation menu on an avatar (remove, mute chat, close), the room setting
// "Who controls playback: everyone / host only", and the three notices (removed with the 10 min wait, chat muted, host has the remote).
// Same palette, plum outline and top-left light as sets (c)/(e)/(f)/(h)/(i). Every motif keeps one meaning:
//   remote        = who controls playback. Wood (it's the TV's), with the cream house badge when only the host holds it.
//   pointing hand = shown out of the room (removed). The leave icon's teal arrow stays "you left by yourself".
//   zip           = chat muted by the host. The speaker-with-a-cross (icon/muted) stays "sound off on your side".
//   timer dial    = how long (set f): the 10 min rejoin wait, on the Rejoin key and on the wall clock beside the door.
//   mustard rim   = only you (sets e/f/h/i): the moderation menu is the host's own tool, so it's the emote picker's tray.
// No new colours: still the 67.
import { vignette } from "./rooms";
import { OUTLINE, colorIndex, type RampName, type Tone } from "./palette";
import { blank, render, stamp, type RoleMap } from "./sprite";
import { all, lit, nine, slab, type UiFrame } from "./ui";

const c = (ramp: RampName, tone: Tone): number => colorIndex(ramp, tone);
const O = OUTLINE;

const ROLES: RoleMap = {
  // Flat highlight, like the key icons of sets (e)/(h)/(i): crisp on night and wood faces at 1×.
  i: { ramp: "cream", tone: 0 },
  C: { ramp: "cream", tone: 2 },
  y: { ramp: "mustard", tone: 0 },
  g: { ramp: "glow", tone: 0 },
  o: { ramp: "outline", tone: 1 },
  // Auto-shaded surfaces.
  c: { ramp: "cream", hi: true },
  m: { ramp: "mustard", hi: true },
  w: { ramp: "wood", hi: true },
  W: { ramp: "wood", tone: 2 },
  d: { ramp: "wood", hi: true, group: "d" },
  x: { ramp: "charcoal", hi: true },
  // Flat keys and lamplight that count as part of the surface they sit on, so the auto shade outlines the shape, not each key.
  k: { ramp: "cream", tone: 0, group: "w" },
  G: { ramp: "glow", tone: 1, group: "w" },
  Y: { ramp: "mustard", tone: 0, group: "d" },
};

function art(keyName: string, rows: readonly string[], ax?: number, ay?: number): UiFrame {
  const w = rows[0]?.length ?? 0, h = rows.length;
  rows.forEach((r, i) => { if (r.length !== w) throw new Error(`${keyName}: row ${String(i)} is ${String(r.length)} wide, not ${String(w)}`); });
  const g = blank(w, h);
  stamp(g, rows, 0, 0);
  return { key: keyName, w, h, img: render(g, ROLES), ax: ax ?? w / 2, ay: ay ?? h / 2 };
}

// ------------------------------------------------------------------ 9-slices

/** Menu row (room scale, inside the emote picker's tray). idle = flat on the tray; hover/focus = a sunken well with the cream
 *  lit edge (the emote cell's hover, stretched into a row); press = the mustard rim. `ask` = the row turned into the question
 *  "Remove Kit for 10 min?": a charcoal well with a cream-shade edge, so the two keys inside it stand out. */
function menuRow(state: "idle" | "hover" | "press" | "ask"): UiFrame {
  const W = 12;
  const img = slab(W, W, 2, (d, e) => {
    if (state === "idle") return c("night", 1);
    if (d === 0) return state === "press" ? c("mustard", 0) : state === "ask" ? c("cream", 2) : lit(e) ? O : c("cream", 0);
    if (d === 1) return lit(e) ? O : state === "ask" ? c("charcoal", 1) : c("night", 0);
    return state === "ask" ? c("charcoal", 2) : c("night", 2);
  });
  return nine(`menu/row/${state}`, W, W, img, all(4));
}

/** Horizontal groove between the menu's header and its rows: plum then the night highlight (the picker's `emotes/sep`, lying down). */
function menuSep(): UiFrame {
  const W = 4;
  const img = new Uint8Array(W * 2);
  for (let x = 0; x < W; x++) { img[x] = O; img[W + x] = c("night", 0); }
  return { key: "menu/sep", w: W, h: 2, img, ax: 0, ay: 0, slice: true };
}

/** A shared key the host holds (owner-only playback, seen by everyone else): still the TV's wood, but sunk into the shelf
 *  (plum shadow top-left, a lit lip bottom-right, no 2 px lip to press). Not charcoal (that's disabled) and no timer (that's resting). */
function heldKey(): UiFrame {
  const W = 16, H = 20;
  const img = slab(W, H, 2, (d, e) => {
    if (d === 0) return O;
    if (d === 1) return lit(e) ? O : c("wood", 1);
    return c("wood", 2);
  });
  return nine("button/shared/held", W, H, img, all(5));
}

/** Chat field when the host muted you: set (c)'s sunken field with a charcoal well (not the night blue you type into) and no ring. */
function mutedInput(): UiFrame {
  const W = 18;
  const img = slab(W, W, 3, (d, e) => {
    if (d === 0) return 0;
    if (d === 1) return O;
    if (d === 2) return lit(e) ? O : c("charcoal", 1);
    return c("charcoal", 2);
  });
  return nine("input/muted", W, W, img, all(6));
}

// ------------------------------------------------------------------ icons and glyphs

const ICONS: Record<string, readonly string[]> = {
  // Remove from the room: a cream hand points the way out through a lit doorway ("show someone out"). Not a boot, not a cross.
  remove: [
    "................",
    ".........dddddd.",
    ".........dYYYYd.",
    ".........dYYYYd.",
    ".........dYYYYd.",
    ".........dYYYYd.",
    ".........dYYYYd.",
    ".xx......dYYYYd.",
    ".xxccccccccYYYd.",
    ".xxcccccccdYYYd.",
    ".xxcccc..dYYYYd.",
    ".xxcccc..dYYYYd.",
    ".xx.cc...dYYYYd.",
    ".........dYYYYd.",
    ".........dddddd.",
    "................",
  ],
  // Chat muted: the chat bubble, zipped shut (plum and cream-shade teeth, a mustard pull hanging off the right).
  "chat-mute": [
    "................",
    "..cccccccccccc..",
    ".cccccccccccccc.",
    ".cccccccccccccc.",
    ".cccccccccccccc.",
    ".oCoCoCoCoCoCoo.",
    ".cccccccccccccy.",
    ".ccccccccccccyy.",
    ".cccccccccccc.y.",
    "..ccccccccccc...",
    "...cc...........",
    "...c............",
    "................",
    "................",
    "................",
    "................",
  ],
  // Everyone controls playback: the room's wood remote (a glow lens: it talks to the TV), a play key and a keypad.
  remote: [
    "................",
    ".....wwwww......",
    "....wwwwwww.....",
    "....wwGGGww.....",
    "....wwwwwww.....",
    "....wwwkwww.....",
    "....wwwkkww.....",
    "....wwwkwww.....",
    "....wwwwwww.....",
    "....wkwkwkw.....",
    "....wwwwwww.....",
    "....wkwkwkw.....",
    "....wwwwwww.....",
    ".....wwwww......",
    "................",
    "................",
  ],
  // Only the host controls playback: the same remote, with the cream house (set h's host glyph) badged on its corner.
  "remote-host": [
    "................",
    "..wwwww.........",
    ".wwwwwww........",
    ".wwGGGww........",
    ".wwwwwww........",
    ".wwwkwww....i...",
    ".wwwkkww...iii..",
    ".wwwkwww..iiiii.",
    ".wwwwwww.iiiiiii",
    ".wkwkwkw..iiiii.",
    ".wwwwwww..iwwii.",
    ".wkwkwkw..iwwii.",
    ".wwwwwww..iwwii.",
    "..wwwww.........",
    "................",
    "................",
  ],
};

const GLYPHS: Record<string, readonly string[]> = {
  // Beside a muted member's name tag (the host's view) and on the "muted your chat" line: a tiny zipped bubble.
  "chat-mute": ["........", ".cccccc.", ".cccccc.", ".oCoCoo.", ".ccccyc.", "..c...y.", "........", "........"],
  // On the "only the host controls playback" line: a tiny remote with its glow lens and play key.
  remote: ["........", "..www...", "..wGw...", "..www...", "..wkw...", "..www...", "..www...", "........"],
};

// ------------------------------------------------------------------ build + CSS

export function buildModerationFrames(): UiFrame[] {
  const out: UiFrame[] = [];
  for (const s of ["idle", "hover", "press", "ask"] as const) out.push(menuRow(s));
  out.push(menuSep(), heldKey(), mutedInput());
  for (const [n, rows] of Object.entries(ICONS)) out.push(art(`icon/${n}`, rows, 8, 8));
  for (const [n, rows] of Object.entries(GLYPHS)) out.push(art(`glyph/${n}`, rows, 4, 4));
  return out;
}

/** The "you were removed" vignette ships like set (i)'s two: a lazy standalone PNG (`ui/scenes/removed.png`). */
export function buildModerationScenes(): UiFrame[] {
  return [vignette("removed")];
}

const u = (n: number): string => (n === 0 ? "0" : `calc(${String(n)} * var(--ui-px))`);

/** Set (j) moderation rules appended to `ui/reference.css`. */
export function moderationCss(): string {
  const slice = (k: string): string => `url("slices/${k.replace(/\//g, "-")}.png")`;
  const nineRule = (k: string, b: number): string =>
    `border-style: solid; border-color: transparent; border-width: ${u(b)}; border-image: ${slice(k)} ${String(b)} fill / ${u(b)} stretch;`;
  const src = (k: string): string => `border-image-source: ${slice(k)};`;
  return `
/* ---- Set (j) (OME-422): house rules. Remote = who controls playback (wood: it's the TV's; the house badge = only the host).
 * Pointing hand = shown out (removed). Zip = the host muted your chat. Timer dial = how long (set f). The moderation menu is the
 * host's own tool, so it wears the mustard "only you" rim: it IS the emote picker's tray (.ui-emotes), with rows instead of cells. */
.ui-modmenu, .ui-modrow, .ui-modsep { image-rendering: pixelated; box-sizing: border-box; }

/* Moderation menu: <div class="ui-emotes ui-modmenu" role="menu" aria-label="Kit"> opened from a member's avatar (host only, never
 * on yourself). Header: .ui-portrait-<avatar> + the name + a square close key (icon/close, Esc). Then .ui-modsep, then the rows.
 * The tail points down at the avatar's name tag: set --ui-tail-x like the picker. */
.ui-emotes.ui-modmenu { display: inline-grid; align-items: stretch; gap: ${u(1)}; min-width: ${u(96)}; }
.ui-modmenu .head { display: flex; align-items: center; gap: ${u(3)}; color: var(--ui-text); font-weight: 700; font-size: 12px; padding: 0 0 0 ${u(1)}; }
.ui-room .ui-modmenu .head { font-size: 11px; }
.ui-modmenu .head .name { flex: 1; }
.ui-modsep { display: block; height: ${u(2)}; background: ${slice("menu/sep")} 0 0 / ${u(4)} ${u(2)} repeat-x; }
/* A row: <button class="ui-modrow" role="menuitem"> icon + words. "Mute chat" (icon/chat-mute) ↔ "Unmute chat" (icon/chat), and
 * "Remove from room" (icon/remove). Remove asks first: the row turns .is-ask with "Remove Kit for 10 min?" + Keep / Remove keys. */
.ui-modrow { ${nineRule("menu/row/idle", 4)} display: flex; align-items: center; gap: ${u(3)}; min-height: ${u(20)}; padding: 0 ${u(1)}; background: none; color: var(--ui-text); font: inherit; font-size: 12px; font-weight: 600; text-align: left; cursor: pointer; }
.ui-room .ui-modrow { font-size: 11px; }
.ui-modrow:hover, .ui-modrow.is-hover, .ui-modrow:focus-visible { ${src("menu/row/hover")} outline: none; }
.ui-modrow:active, .ui-modrow.is-press { ${src("menu/row/press")} }
.ui-modrow.is-ask { ${src("menu/row/ask")} cursor: default; flex-wrap: wrap; padding: ${u(1)}; }
.ui-modrow.is-ask .ui-button { font-size: 11px; min-height: ${u(16)}; }

/* Owner-only playback, seen by everyone but the host: each shared key is .ui-button.shared.is-held (aria-disabled="true", label
 * "Only the host controls playback"), its icon the -off variant. The shelf chip reads glyph/host + "Host" instead of "Everyone". */
.ui-button.shared.is-held { ${src("button/shared/held")} cursor: default; padding: 0 0 ${u(2)}; }

/* The host muted your chat: the chat field is .ui-input.is-muted (readonly, aria-describedby the line) with glyph/chat-mute
 * before the words "The host muted your chat"; Send is disabled. A .ui-sysline.self says it once in the log. */
.ui-input.is-muted { ${src("input/muted")} color: var(--ui-disabled-text); cursor: not-allowed; }
.ui-input.is-muted::placeholder { color: var(--ui-disabled-text); }

/* You were removed (the page, or a card on .ui-scrim mid-film): .ui-scene.ui-scene-removed, "You were removed from this room", the
 * wait in words, then a Rejoin key that is set (f)'s .is-waiting + .ui-wait over the 10 min (--cool: 600s), then primary. */
.ui-scene-removed { background-image: url("scenes/removed.png"); }
`;
}
