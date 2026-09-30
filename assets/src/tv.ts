// M1b TV frame (OME-92). Since ADR 0012 the YouTube player and its control bar are unscaled page chrome above the
// room stage (apps/web/src/layout.ts `roomLayout`). These two 9-slices dress those boxes without moving them:
// CSS `border-image-outset` paints the wood bezel and the media shelf *outside* the boxes (ink overflow, no layout
// change), so nothing is ever drawn over the player, and the control bar box itself is the shelf's transport slot.
import { addOutline } from "./iso";
import { colorIndex } from "./palette";
import { TV_BEZEL, TV_SHELF, bezelPaint, shelfPaint } from "./room";
import type { Borders, UiFrame } from "./ui";

/** `tvframe/bezel`: outline + wood bezel round a 2×2 transparent hole (the player). Slices = the bezel widths. */
function bezel(): UiFrame {
  const B = TV_BEZEL, hole = 2;
  const W = B.side + hole + B.side, H = B.top + hole + B.bottom;
  const s = { x: B.side, y: B.top, w: hole, h: hole };
  const img = new Uint8Array(W * H);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const p = bezelPaint(x, y, s);
      if (p) img[y * W + x] = colorIndex(p[0], p[1]);
    }
  }
  // Outer outline only: the hole stays transparent (the charcoal lip is the inner edge).
  const o = colorIndex("outline", 1);
  for (let x = 0; x < W; x++) {
    img[x] = o;
    img[(H - 1) * W + x] = o;
  }
  for (let y = 0; y < H; y++) {
    img[y * W] = o;
    img[y * W + W - 1] = o;
  }
  return { key: "tvframe/bezel", w: W, h: H, img, ax: 0, ay: 0, borders: { left: B.side, top: B.top, right: B.side, bottom: B.bottom }, slice: true };
}

/** Height of the control bar box the shelf's slot must match (layout.ts `CONTROL_BAR_H`). */
export const SLOT_H = 44;

/** `tvframe/shelf`: the centre (2×44, flat night) is the control bar box; the slot's plum shadow, lit lip, rail and
 *  both speaker cabinets are outside it. Fixed height: the side slices hold the speakers and never stretch. */
function shelf(): UiFrame {
  const S = TV_SHELF;
  const half = 2 + S.speaker; // 4-wide symmetric slot (shadow col, 2 box cols, lip col) + speakers
  const W = 1 + 2 * half + 1, faceH = SLOT_H + 1 + S.rail, H = 1 + faceH + 1;
  const slot = { x: -2, y: -1, w: 4, h: SLOT_H + 2 };
  const img = new Uint8Array(W * H);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const p = shelfPaint(x - 1 - half, y - 1, half, faceH, slot);
      img[y * W + x] = colorIndex(p[0], p[1]);
    }
  }
  addOutline(img, W, H);
  const borders: Borders = { left: half, top: 1, right: W - half - 2, bottom: H - 1 - SLOT_H };
  return { key: "tvframe/shelf", w: W, h: H, img, ax: 0, ay: 0, borders, slice: true, fixedHeight: true };
}

export function buildTvFrames(): UiFrame[] {
  return [bezel(), shelf()];
}

/** TV rules appended to `ui/reference.css`. Plain CSS px: the player and control bar are laid out 1:1 (ADR 0012). */
export function tvCss(): string {
  const b = bezel().borders, sh = shelf().borders;
  if (!b || !sh) throw new Error("tv slices lost their borders");
  const px = (n: number): string => (n === 0 ? "0" : `${String(n)}px`);
  const trbl = (x: Borders, side = true): string => `${px(x.top)} ${side ? px(x.right) : "0"} ${px(x.bottom)} ${side ? px(x.left) : "0"}`;
  const nums = (x: Borders): string => `${String(x.top)} ${String(x.right)} ${String(x.bottom)} ${String(x.left)}`;
  return `
/* ---- M1b TV frame (OME-92, ADR 0012): dress the page-level player and control bar in the room's wood. ----
 * Put .ui-tv-frame on the player box (.tv) and .ui-tv-shelf on the control bar box (.controls), at the rects
 * roomLayout() gives. border-image-outset paints outside each box (ink overflow: no layout change, no scrollbars),
 * so nothing ever covers the player. The bezel needs ${String(b.top)} px above the player (tv.y) and fills the ${String(b.bottom)} px gap below it;
 * the shelf's ${String(sh.top)} px top outset overlaps the bezel's last row by ${String(sh.top)} px: both are the plum outline there, so it's harmless;
 * the shelf needs ${String(sh.bottom)} px under the bar (the gap to the stage is 8) and ${String(sh.left)} px each side for its speakers.
 * The bar box is the transport slot: lay .ui-transport straight in it (no .ui-panel). */
.ui-tv-frame { border: 0 solid transparent; border-image: url("slices/tvframe-bezel.png") ${nums(b)} / ${trbl(b)} / ${trbl(b)} stretch; image-rendering: pixelated; }
.ui-tv-shelf { box-sizing: border-box; height: ${px(SLOT_H)}; display: flex; align-items: center; padding: 0 6px; border: 0 solid transparent; border-image: url("slices/tvframe-shelf.png") ${nums(sh)} fill / ${trbl(sh)} / ${trbl(sh)} stretch; image-rendering: pixelated; }
.ui-tv-shelf > .ui-transport { flex: 1; min-width: 0; }
.ui-tv-shelf .ui-seek { min-width: 0; }
/* Add .compact when the speakers don't fit beside the bar, i.e. container width < bar width + ${String(sh.left + sh.right)} px (${String(sh.left)} px each side):
 * drop them, keep the slot's rails. */
.ui-tv-shelf.compact { border-image-width: ${trbl(sh, false)}; border-image-outset: ${trbl(sh, false)}; }
/* Same for the bezel sides on a 360 px viewport (the 356 px player leaves 2 px each side). */
.ui-tv-frame.compact { border-image-width: ${trbl(b, false)}; border-image-outset: ${trbl(b, false)}; }
`;
}
