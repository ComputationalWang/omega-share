// Set (l) (OME-644), M8: floating chat bubbles, the radial emote wheel, the keycap for "Press Enter to chat", and the wide desktop
// layout's chat column. Same palette, plum outline and top-left light as every other set. One meaning per motif:
//   cream card     = someone talking (set c's bubble, set k's fresh strip line). A bubble is that line, floating over the speaker.
//   mustard rim    = you: your own bubble wears tag/self's rim, the wheel is yours alone (sets e/f/h/i/k: mustard = only you).
//   the tail       = who said it. It always points at the speaker's head; a bubble pushed up a stack has no tail and names the speaker.
//   a ring of six  = the emote wheel: the same six stickers, in the same order, as set (i)'s picker and keys 1–6.
// No new colours: still the 67.
import { OUTLINE, colorIndex, type RampName, type Tone } from "./palette";
import { blank, render, stamp, type RoleMap } from "./sprite";
import { lit, nine, slab, type UiFrame } from "./ui";

const c = (ramp: RampName, tone: Tone): number => colorIndex(ramp, tone);
const O = OUTLINE;

// ------------------------------------------------------------------ bubbles (room scale, 1 art px = 1 stage px)

/** The floating bubble: set (k)'s fresh cream card, one size up, with a 2 px plum foot so it lifts off busy floors and walls.
 *  `self` swaps the cream lit edge for tag/self's mustard rim. */
function floatCard(self: boolean): UiFrame {
  const W = 14, H = 14;
  const card = slab(W, H - 1, 2, (d, e) => {
    if (d === 0) return O;
    if (d === 1) return self ? (lit(e) ? c("mustard", 0) : c("mustard", 2)) : lit(e) ? c("cream", 0) : c("cream", 2);
    return c("cream", 1);
  });
  const img = new Uint8Array(W * H);
  img.set(card);
  // The foot: a second outline row under the bottom edge, inside the chamfer.
  for (let x = 2; x < W - 2; x++) img[(H - 1) * W + x] = O;
  return nine(`bubble/float${self ? "-self" : ""}`, W, H, img, { left: 5, top: 5, right: 5, bottom: 6 });
}

/** Tails, 12×7. Their top 3 rows sit over the card's bottom 3 (lip, outline, foot) and open them, so the tail reads as part of the card;
 *  4 rows show below it. `s` points straight down (a 45° V); `sw` / `se` keep one straight side and lean 2:1 toward a speaker the bubble
 *  had to leave (clamped at the stage or view edge). Anchor = the tip, so engineering puts the tip on the speaker's x. */
const TAIL_W = 12, TAIL_H = 7;
function tail(dir: "s" | "sw" | "se"): UiFrame {
  const img = new Uint8Array(TAIL_W * TAIL_H);
  const set = (x: number, y: number, v: number): void => {
    if (x >= 0 && x < TAIL_W) img[y * TAIL_W + (dir === "se" ? TAIL_W - 1 - x : x)] = v;
  };
  for (let x = 0; x < TAIL_W; x++) set(x, 0, c("cream", 1));
  for (let y = 1; y < TAIL_H; y++) {
    if (dir === "s") {
      // Edges close in 1 px a side per row; the shade side is the right one.
      const l = y - 1, r = TAIL_W - y;
      if (l >= r) { set(l, y, O); set(r, y, O); continue; }
      for (let x = l + 1; x < r; x++) set(x, y, c("cream", 1));
      if (r - l > 2) set(r - 1, y, c("cream", 2));
      set(l, y, O); set(r, y, O);
    } else {
      // One straight outer side (x 0), the inner side steps 2 px a row toward it: a 2:1 lean.
      const r = TAIL_W - 1 - 2 * (y - 1);
      if (r <= 1) { set(0, y, O); set(1, y, O); set(2, y, r === 1 ? O : 0); continue; }
      for (let x = 1; x < r - 1; x++) set(x, y, c("cream", 1));
      // sw: the slanted side faces down-right (shade); se is the mirror, so its slanted side is lit: no shade there.
      if (dir === "sw") set(r - 2, y, c("cream", 2));
      set(0, y, O); set(r - 1, y, O); set(r, y, O);
    }
  }
  const tip = dir === "s" ? TAIL_W / 2 : dir === "sw" ? 1 : TAIL_W - 1;
  return { key: `bubble/tail-${dir}`, w: TAIL_W, h: TAIL_H, img, ax: tip, ay: TAIL_H, slice: true };
}

// ------------------------------------------------------------------ emote wheel (page chrome, --ui-px)

/** Geometry shared by the art, the CSS and `meta.omega.wheel`. Odd sizes so every circle has a centre pixel. */
export const WHEEL = {
  size: 77,
  centre: 38,
  /** Slot centres sit this far from the wheel's centre, every 60°, clockwise from 12 o'clock. */
  radius: 24,
  slot: 21,
  hub: 21,
  focus: 27,
  /** Same order as set (i)'s picker and keys 1–6. */
  order: ["heart", "laugh", "question", "exclaim", "clap", "wave"],
} as const;

/** Top-left of slot k inside the wheel (whole art px; the left/right pairs mirror exactly about the centre). */
export function slotOrigin(k: number): { x: number; y: number } {
  const a = ((-90 + 60 * k) * Math.PI) / 180;
  const half = (WHEEL.slot - 1) / 2;
  return { x: WHEEL.centre + Math.round(WHEEL.radius * Math.cos(a)) - half, y: WHEEL.centre + Math.round(WHEEL.radius * Math.sin(a)) - half };
}

/** Paint a size×size disc by distance from the centre pixel. */
function disc(size: number, paint: (d: number, ul: number, x: number, y: number) => number): Uint8Array {
  const img = new Uint8Array(size * size);
  const m = (size - 1) / 2;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = x - m, dy = y - m;
    // ul > 0 on the lit (upper-left) side, < 0 on the shade side.
    img[y * size + x] = paint(Math.hypot(dx, dy), -(dx + dy), x, y);
  }
  return img;
}
const tone3 = (ul: number, d: number, ramp: RampName): number => {
  const k = d === 0 ? 0 : ul / (d * Math.SQRT2);
  return c(ramp, k > 0.3 ? 0 : k < -0.3 ? 2 : 1);
};

/** The wheel: a night tray in a mustard rim (the picker's materials, made round), six spoke grooves between the slots so it reads
 *  as a wheel even with the slots empty, and a sunken ring round the hub. Hub and slots are separate sprites on top. */
function wheelDisc(): UiFrame {
  const { size, centre } = WHEEL;
  const spokes = [-60, 0, 60, 120, 180, 240].map((a) => (a * Math.PI) / 180);
  const img = disc(size, (d, ul, x, y) => {
    if (d >= 38.5) return 0;
    if (d >= 37.5) return O;
    if (d >= 35.5) return tone3(ul, d, "mustard");
    if (d < 10.5) return 0;
    if (d < 11.5) return c("night", 2);
    // Inner shadow under the rim on the lit side (the tray is sunk into it).
    if (d >= 34.5 && ul > 0) return c("night", 2);
    const ang = Math.atan2(y - centre, x - centre);
    for (const s of spokes) {
      const off = Math.abs(Math.sin(ang - s)) * d;
      if (d > 15 && d < 33 && off < 0.6 && Math.cos(ang - s) > 0) return c("night", 2);
    }
    return c("night", 1);
  });
  return { key: "wheel/disc", w: size, h: size, img, ax: centre, ay: centre };
}

type SlotState = "idle" | "hover" | "selected" | "press" | "cool";
/** A slot: a round well for one 16 px sticker. idle = sunken night well · hover = cream lit edge · selected = mustard rim (the one
 *  Enter sends; arrow keys move it) · press = mustard rim, deeper well (the CSS drops the sticker 1 px) · cool = charcoal (slowed). */
function wheelSlot(state: SlotState): UiFrame {
  const S = WHEEL.slot;
  const img = disc(S, (d, ul) => {
    if (d >= 10.5) return 0;
    if (d >= 9.5) return O;
    const edge = d >= 8.5;
    switch (state) {
      case "idle":
        return edge ? (ul > 0 ? c("night", 2) : c("night", 0)) : c("night", 2);
      case "hover":
        return edge ? (ul > 0 ? c("cream", 2) : c("cream", 0)) : c("night", 1);
      case "selected":
        return d >= 7.5 ? tone3(ul, d, "mustard") : c("night", 1);
      case "press":
        return edge ? tone3(-ul, d, "mustard") : c("night", 2);
      case "cool":
        return edge ? (ul > 0 ? c("charcoal", 2) : c("charcoal", 0)) : c("charcoal", 2);
    }
  });
  const h = (S - 1) / 2;
  return { key: `wheel/slot/${state}`, w: S, h: S, img, ax: h, ay: h };
}

/** Keyboard focus: set (c)'s focus language made round, a 1 art px cream ring with plum on both sides, 1 px clear of the slot. */
function wheelFocus(): UiFrame {
  const F = WHEEL.focus;
  const img = disc(F, (d) => (d >= 13.5 ? 0 : d >= 12.5 ? O : d >= 11.5 ? c("cream", 0) : d >= 10.5 ? O : 0));
  const h = (F - 1) / 2;
  return { key: "wheel/focus", w: F, h: F, img, ax: h, ay: h };
}

/** The hub: a wood bezel round a deep night well. It previews the selected sticker (or icon/emote before anything is picked). */
function wheelHub(): UiFrame {
  const S = WHEEL.hub;
  const img = disc(S, (d, ul) => (d >= 10.5 ? 0 : d >= 9.5 ? O : d >= 8 ? tone3(ul, d, "wood") : d >= 7 ? O : c("night", 2)));
  const h = (S - 1) / 2;
  return { key: "wheel/hub", w: S, h: S, img, ax: h, ay: h };
}

/** Tail from the wheel's rim down to your head. Its top 3 rows open the rim's bottom (tray, rim, outline). */
function wheelTail(): UiFrame {
  const rows = ["kkkkkkkkk", "mkkkkkkkM", "OmkkkkkMO", ".OmkkkMO.", "..OmkMO..", "...OMO...", "....O...."];
  const w = rows[0]?.length ?? 0, h = rows.length;
  const img = new Uint8Array(w * h);
  rows.forEach((r, y) => {
    for (let x = 0; x < w; x++) {
      const ch = r.charAt(x);
      img[y * w + x] = ch === "O" ? O : ch === "k" ? c("night", 1) : ch === "m" ? c("mustard", 0) : ch === "M" ? c("mustard", 2) : 0;
    }
  });
  return { key: "wheel/tail", w, h, img, ax: (w - 1) / 2, ay: h, slice: true };
}

// ------------------------------------------------------------------ icon + keycap

const ROLES: RoleMap = {
  c: { ramp: "cream", hi: true },
  m: { ramp: "mustard", hi: true },
  k: { ramp: "night", tone: 1 },
};

/** The touch key by the chat input: six beads round a small face, the top one lit mustard: "pick one from the ring". */
function wheelIcon(): UiFrame {
  const rows = [
    "................",
    ".......mm.......",
    ".......mm.......",
    "................",
    "..cc........cc..",
    "..cc........cc..",
    "......cccc......",
    ".....cckkcc.....",
    ".....cccccc.....",
    "......cccc......",
    "..cc........cc..",
    "..cc........cc..",
    "................",
    ".......cc.......",
    ".......cc.......",
    "................",
  ];
  const g = blank(16, 16);
  stamp(g, rows, 0, 0);
  return { key: "icon/wheel", w: 16, h: 16, img: render(g, ROLES), ax: 8, ay: 8 };
}

/** A keycap for hints ("Press [Enter] to chat", "[T] emotes"): cream key, plum outline, a 2 px shade lip. Fixed height 12. */
function keycap(): UiFrame {
  const W = 12, H = 12;
  // Drawn by row so the lip is flat across (a chamfered ring would slant it into the side slices). Corners cut 1 px.
  const img = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const edgeX = x === 0 || x === W - 1, edgeY = y === 0 || y === H - 1;
    if (edgeX && edgeY) continue;
    let v: number;
    if (edgeX || edgeY) v = O;
    else if (y >= H - 3) v = c("cream", 2);
    else if (y === 1 || x === 1) v = c("cream", 0);
    else if (x === W - 2) v = c("cream", 2);
    else v = c("cream", 1);
    img[y * W + x] = v;
  }
  return { ...nine("kbd/0", W, H, img, { left: 4, top: 3, right: 4, bottom: 4 }), fixedHeight: true };
}

export function buildChatFloatFrames(): UiFrame[] {
  return [
    floatCard(false), floatCard(true), tail("s"), tail("sw"), tail("se"),
    wheelDisc(), ...(["idle", "hover", "selected", "press", "cool"] as const).map(wheelSlot), wheelFocus(), wheelHub(), wheelTail(),
    wheelIcon(), keycap(),
  ];
}

// ------------------------------------------------------------------ motion + stacking spec (meta.omega.bubbles / wheel)

/** Bubble float, in ms and stage px. Engineering reads these from `ui.json` `meta.omega.bubbles`; the CSS below bakes the same numbers for the
 *  standalone component. The room runs `room` instead: the same rise and fade, stepped by script (see below). */
export const BUBBLES = {
  lifeMs: 5000,
  /** Fade in over the first appearMs (3 opacity steps), hold, then ease-in to 0 from fadeAtMs to lifeMs. */
  appearMs: 120,
  fadeAtMs: 3600,
  fadeCurve: "cubic-bezier(0.55, 0, 1, 0.45)",
  /** Rise over the whole life, 1 stage px per step (steps(rise)): crisp pixels, never a sub-pixel blur. */
  rise: 24,
  /** Room-scale box: text 12/15 px, at most 3 lines, at most maxW wide (stage px, border box). */
  maxW: 168,
  maxLines: 3,
  /** The tail shows tailBelow px under the card; its tip is the anchor: floor y − tagLiftByAvatar[id][pose] (2 px over the head).
   *  Stacked bubbles keep gap px apart; margin from the stage (or visible window) edges. */
  tailBelow: 4,
  gap: 3,
  margin: 4,
  /** A bubble pushed up the stack slides there in pushMs (4 steps); one that has to go early fades in leaveMs. */
  pushMs: 160,
  leaveMs: 160,
  maxOnScreen: 8,
  maxPerSpeaker: 2,
  reduced: { rise: 0, appearMs: 0, fadeAtMs: 4000, fadeCurve: "linear", pushMs: 0, leaveMs: 0 },
  /** In the room the motion is stepped by script, never by CSS (ADR 0039, OME-802/OME-830): one shared clock for the whole layer, `steps`
   *  ticks a life (step i at i × lifeMs / steps). Each tick writes the rise (whole px) and the fade (sampled on the ticks, about 7 levels over
   *  the 1.4 s ease-in) on a bare wrapper. Against the numbers above: no fade-in (the bubble shows whole, appearMs 0); a push is instant
   *  (pushMs 0); a bubble that leaves early drops to leaveOpacity, then goes on the first tick at least leaveMs later. Anything that comes
   *  back comes back as extra ticks on this clock, never as a CSS animation or transition. The keyframes in reference.css are for the
   *  standalone component (previews, docs) only. */
  room: { driver: "script", steps: 24, appearMs: 0, pushMs: 0, leaveMs: 160, leaveOpacity: 0.5, adr: "docs/adr/0039-bubble-motion-on-a-step-clock.md" },
} as const;

/** Emote wheel geometry + keys for engineering (`meta.omega.wheel`). Slot origins are art px inside the wheel. */
export function wheelMeta(): Record<string, unknown> {
  return {
    ...WHEEL,
    slots: WHEEL.order.map((id, k) => ({ id, key: String(k + 1), ...slotOrigin(k) })),
    hubOrigin: { x: WHEEL.centre - (WHEEL.hub - 1) / 2, y: WHEEL.centre - (WHEEL.hub - 1) / 2 },
    focusInset: (WHEEL.focus - WHEEL.slot) / 2,
    keys: { open: "t", close: ["Escape", "t"], next: ["ArrowRight", "ArrowDown"], prev: ["ArrowLeft", "ArrowUp"], first: "Home", last: "End", send: ["Enter", " "], direct: ["1", "2", "3", "4", "5", "6"] },
  };
}

// ------------------------------------------------------------------ reference CSS

const u = (n: number): string => (n === 0 ? "0" : `calc(${String(n)} * var(--ui-px))`);

/** Set (l) rules appended to `ui/reference.css`. */
export function chatFloatCss(rects: Readonly<Record<string, { x: number; y: number; w: number; h: number }>>): string {
  const slice = (k: string): string => `url("slices/${k.replace(/\//g, "-")}.png")`;
  const rect = (k: string): { x: number; y: number; w: number; h: number } => {
    const r = rects[k];
    if (!r) throw new Error(`missing ${k}`);
    return r;
  };
  /** Size + sheet offset of a ui.png sprite. */
  const pos = (k: string): string => {
    const r = rect(k);
    return `width: ${u(r.w)}; height: ${u(r.h)}; background-position: ${u(-r.x)} ${u(-r.y)};`;
  };
  /** Sheet offset only (state swaps on the same box). */
  const at = (k: string): string => {
    const r = rect(k);
    return `background-position: ${u(-r.x)} ${u(-r.y)};`;
  };
  const sheet = `background: url("ui.png") no-repeat; background-size: calc(256 * var(--ui-px)) calc(512 * var(--ui-px));`;
  const B = BUBBLES;
  const fadeAt = ((B.fadeAtMs / B.lifeMs) * 100).toFixed(1);
  const inAt = ((B.appearMs / B.lifeMs) * 100).toFixed(1);
  const rFadeAt = ((B.reduced.fadeAtMs / B.lifeMs) * 100).toFixed(1);
  const slots = WHEEL.order.map((id, k) => {
    const o = slotOrigin(k);
    return `.ui-wheel-slot:nth-child(${String(k + 1)}) { left: ${u(o.x)}; top: ${u(o.y)}; } /* ${id}, key ${String(k + 1)} */`;
  }).join("\n");
  const hub = WHEEL.centre - (WHEEL.hub - 1) / 2;
  const fi = (WHEEL.focus - WHEEL.slot) / 2;
  return `
/* ---- Set (l) (OME-644), M8: floating chat bubbles, the emote wheel, the keycap hint and the wide desktop layout.
 * Bubbles are decorative (the chat log is the accessible record): .ui-bubbles is aria-hidden="true", never a live region. */
.ui-float, .ui-wheel, .ui-wheel-slot, .ui-wheel-hub, .ui-kbd, .ui-chatcol { image-rendering: pixelated; box-sizing: border-box; }

/* A bubble: <p class="ui-float [is-self]" style="left: Lpx; top: Tpx; --tail-x: Xpx"><span class="say">…</span></p> in the stage overlay, room scale (--ui-px: 1px).
 * JS sets left/top to the bubble's resting border box (stage px, see meta.omega.bubbles for the stacking rule) and --tail-x to the speaker's
 * x inside that box. Tail: .tail-s (default) points straight down; .tail-sw / .tail-se when the box was clamped at the stage edge and the
 * speaker is past the tail's reach. .is-stacked (pushed up by a newer bubble) has no tail and starts with <b class="who">Name</b>.
 * The keyframes and the push transition below are the standalone component. The room turns them off and steps the same rise and fade by
 * script on one shared clock (meta.omega.bubbles.room, ADR 0039): no fade-in, an instant push, an early exit at half opacity for one tick. */
.ui-float { border-style: solid; border-color: transparent; border-width: ${u(5)} ${u(5)} ${u(6)} ${u(5)}; border-image: ${slice("bubble/float")} 5 5 6 5 fill / ${u(5)} ${u(5)} ${u(6)} ${u(5)} stretch;
  position: absolute; margin: 0; width: max-content; max-width: ${String(B.maxW)}px; padding: 0 ${u(1)};
  color: var(--ui-bubble-text); font: 500 12px/15px system-ui, sans-serif; overflow-wrap: anywhere; pointer-events: none;
  transform: translateY(var(--push, 0px)); transition: transform ${String(B.pushMs)}ms steps(4, end);
  animation: ui-float-rise ${String(B.lifeMs)}ms steps(${String(B.rise)}, end) both, ui-float-life ${String(B.lifeMs)}ms linear both; }
.ui-float.is-self { border-image-source: ${slice("bubble/float-self")}; }
.ui-float .who { font-weight: 700; margin-right: 0.35em; }
/* The words go in <span class="say"> (with .who first when stacked): the ${String(B.maxLines)}-line clamp needs overflow hidden, and on the
 * bubble itself that would clip the tail. The full message is always in the chat log. */
.ui-float .say { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: ${String(B.maxLines)}; line-clamp: ${String(B.maxLines)}; overflow: hidden; }
.ui-float::after { content: ""; position: absolute; top: calc(100% + ${u(6 - 3)}); left: calc(var(--tail-x, 50%) - ${u(TAIL_W / 2)}); width: ${u(TAIL_W)}; height: ${u(TAIL_H)}; background: ${slice("bubble/tail-s")} 0 0 / 100% 100%; }
.ui-float.tail-sw::after { left: calc(var(--tail-x) - ${u(1)}); background-image: ${slice("bubble/tail-sw")}; }
.ui-float.tail-se::after { left: calc(var(--tail-x) - ${u(TAIL_W - 1)}); background-image: ${slice("bubble/tail-se")}; }
.ui-float.is-stacked::after { content: none; }
.ui-float.is-leaving { animation: ui-float-leave ${String(B.leaveMs)}ms steps(4, end) forwards; }
@keyframes ui-float-rise { from { translate: 0 0; } to { translate: 0 -${String(B.rise)}px; } }
@keyframes ui-float-life {
  0% { opacity: 0; animation-timing-function: steps(3, end); }
  ${inAt}% { opacity: 1; }
  ${fadeAt}% { opacity: 1; animation-timing-function: ${B.fadeCurve}; }
  100% { opacity: 0; }
}
@keyframes ui-float-leave { to { opacity: 0; } }
/* Reduced motion: no rise, no slide, no fade-in. It shows at once, holds ${String(B.reduced.fadeAtMs / 1000)} s, fades out linearly over ${String((B.lifeMs - B.reduced.fadeAtMs) / 1000)} s; an early exit is instant. */
@media (prefers-reduced-motion: reduce) {
  .ui-float { transition: none; animation: ui-float-life-reduced ${String(B.lifeMs)}ms linear both; }
  .ui-float.is-leaving { animation: none; opacity: 0; }
}
@keyframes ui-float-life-reduced { 0%, ${rFadeAt}% { opacity: 1; } 100% { opacity: 0; } }

/* Emote wheel: <div class="ui-wheel" role="menu" aria-label="Emotes"> in page chrome (--ui-px: 2px, never inside the scaled stage), its
 * tail tip on your bubble anchor (stageToPage). Six <button class="ui-wheel-slot" role="menuitem" aria-keyshortcuts="1".."6"
 * aria-label="Heart"> (roving tabindex), then <span class="ui-wheel-hub"> with the selected sticker, then the label chip.
 * Slots hold .ui-emote-pick-<id> (set i). At 2× each slot is ${String(WHEEL.slot * 2)} CSS px: touch-sized without extra hit areas. */
.ui-wheel { position: absolute; ${sheet} ${pos("wheel/disc")} }
.ui-wheel::after { content: ""; position: absolute; left: 50%; top: calc(100% - ${u(3)}); width: ${u(9)}; height: ${u(7)}; translate: -50% 0; background: ${slice("wheel/tail")} 0 0 / 100% 100%; }
.ui-wheel.no-tail::after { content: none; }
.ui-wheel-slot { position: absolute; display: grid; place-items: center; padding: 0; border: 0; cursor: pointer; ${sheet} ${pos("wheel/slot/idle")} outline: none; }
${slots}
.ui-wheel-slot:hover, .ui-wheel-slot.is-hover { ${at("wheel/slot/hover")} }
.ui-wheel-slot[aria-current="true"], .ui-wheel-slot:focus-visible, .ui-wheel-slot.is-selected { ${at("wheel/slot/selected")} }
.ui-wheel-slot:active, .ui-wheel-slot.is-press { ${at("wheel/slot/press")} }
.ui-wheel-slot:active > .ui-sprite, .ui-wheel-slot.is-press > .ui-sprite { translate: 0 ${u(1)}; }
.ui-wheel-slot[aria-disabled="true"] { ${at("wheel/slot/cool")} cursor: default; }
.ui-wheel-slot[aria-disabled="true"] > .ui-sprite { opacity: 0.45; }
/* Focus ring (keyboard only): drawn round the slot, ${String(fi)} art px out. Never on pointer hover. */
.ui-wheel-slot:focus-visible::after, .ui-wheel-slot.is-focus::after { content: ""; position: absolute; left: ${u(-fi)}; top: ${u(-fi)}; ${sheet} ${pos("wheel/focus")} }
.ui-wheel-hub { position: absolute; left: ${u(hub)}; top: ${u(hub)}; display: grid; place-items: center; ${sheet} ${pos("wheel/hub")} }
/* The label chip says the selected emote and its key, above the wheel (below it would sit on your own avatar). */
.ui-wheel-label { position: absolute; left: 50%; bottom: calc(100% + ${u(3)}); translate: -50% 0; }
.ui-wheel-label .ui-kbd { margin-left: ${u(2)}; }
/* Open/close: 4 steps of opacity over 80 ms (none under reduced motion). Nothing scales: pixel art never resamples. */
.ui-wheel { animation: ui-wheel-in 80ms steps(4, end) both; }
@keyframes ui-wheel-in { from { opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .ui-wheel { animation: none; } }

/* Keycap: <kbd class="ui-kbd">Enter</kbd> inline in hints. Page chrome (2×) only: at 1× a 12 px key can't hold a word. Fixed height 12 art px; the label sits on the key face, above the lip. */
.ui-kbd { border-style: solid; border-color: transparent; border-width: ${u(3)} ${u(4)} ${u(4)} ${u(4)}; border-image: ${slice("kbd/0")} 3 4 4 4 fill / ${u(3)} ${u(4)} ${u(4)} ${u(4)} stretch;
  display: inline-flex; align-items: center; height: ${u(12)}; padding: 0; vertical-align: middle; color: var(--ui-bubble-text); font: 700 11px/1 system-ui, sans-serif; }
.ui-kbd.is-small { font-size: 9px; } /* a single digit or letter in a chip */

/* Wide desktop layout (OME-642, ≥ 1024 px and landscape): <main class="ui-wide"> = the TV + shelf + stage on the left, the chat column on the
 * right at full viewport height. Nothing you need while watching scrolls the page at 1280×720. */
@media (min-width: 1024px) and (orientation: landscape) {
  .ui-wide { display: grid; grid-template-columns: minmax(0, 1fr) var(--ui-chatcol-w, 320px); gap: 16px; height: 100dvh; overflow: hidden; padding: 0 0 0 16px; box-sizing: border-box; }
  .ui-wide > .ui-wide-main { min-width: 0; overflow: hidden; display: grid; grid-template-rows: auto auto minmax(0, 1fr); gap: 8px; padding-top: 6px; }
}
/* The chat column is set (k)'s strip standing beside the room instead of the picture: the wood spine faces the stage. Head (icon/chat,
 * the people count, the pop-out key), the log (role=log, aria-live=polite), the composer at the foot. */
.ui-chatcol { border-style: solid; border-color: transparent; border-width: ${u(2)} ${u(2)} ${u(2)} ${u(5)}; border-image: ${slice("fs/strip")} 2 2 2 5 fill / ${u(2)} ${u(2)} ${u(2)} ${u(5)} stretch;
  display: grid; grid-template-rows: auto minmax(0, 1fr) auto; gap: 8px; height: 100%; min-height: 0; padding: 10px 12px 12px 10px; color: var(--ui-text); }
.ui-chatcol-head { display: flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 700; }
.ui-chatcol-head .n { margin-left: auto; font-size: 12px; font-weight: 600; color: var(--ui-muted); }
.ui-composer { display: flex; align-items: center; gap: 4px; }
.ui-composer .field { position: relative; flex: 1; min-width: 0; display: grid; }
.ui-composer .field > .ui-input { width: 100%; font: 500 13px system-ui, sans-serif; }
/* "Press Enter to chat": a hint layered over the empty, unfocused field. It's aria-hidden; the input's aria-keyshortcuts="Enter" and its label
 * carry the same words. Hidden on touch (no Enter key to press) and the moment the field has focus or text. */
.ui-chat-hint { position: absolute; inset: 0; display: flex; align-items: center; gap: 4px; padding: 0 12px; pointer-events: none; color: var(--ui-muted); font: 500 13px system-ui, sans-serif; white-space: nowrap; overflow: hidden; }
.ui-composer .field > .ui-input:focus ~ .ui-chat-hint, .ui-composer .field > .ui-input:not(:placeholder-shown) ~ .ui-chat-hint { display: none; }
@media (pointer: coarse) { .ui-chat-hint { display: none; } }
`;
}
