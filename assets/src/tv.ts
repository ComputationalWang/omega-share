// M1b TV frame as DOM 9-slices (OME-92). The same pixels as the room's `tv/0` bezel and media shelf
// (bezelPaint / shelfPaint in room.ts), for when the web draws the player outside the scaled stage:
// then the wood frame wraps the iframe at any CSS size, and the transport sits in the shelf's slot.
import { addOutline } from "./iso";
import { colorIndex } from "./palette";
import { TV_BEZEL, TV_SHELF, bezelPaint, shelfPaint } from "./room";
import type { UiFrame } from "./ui";

/** `tvframe/bezel`: 1 px outline + bezel + a plum ring round the screen hole. The centre is transparent (the iframe). */
function bezel(): UiFrame {
  const B = TV_BEZEL, hole = 4;
  const W = 1 + B.side + hole + B.side + 1, H = 1 + B.top + hole + B.bottom + 1;
  const s = { x: 1 + B.side, y: 1 + B.top, w: hole, h: hole };
  const img = new Uint8Array(W * H);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const p = bezelPaint(x, y, s);
      if (p) img[y * W + x] = colorIndex(p[0], p[1]);
    }
  }
  addOutline(img, W, H);
  return { key: "tvframe/bezel", w: W, h: H, img, ax: 0, ay: 0, borders: { left: 2 + B.side, top: 2 + B.top, right: 2 + B.side, bottom: 2 + B.bottom }, slice: true };
}

/** Fixed height of `tvframe/shelf` (art px): outline, 4 px ledge, rail, 44 px slot, rail, outline. */
export const SHELF_H = 1 + TV_SHELF.ledge + TV_SHELF.rail + 44 + TV_SHELF.rail + 1;
/** Where the slot is inside `tvframe/shelf`, from its top-left, for positioning the transport over it. */
export const SHELF_SLOT = { left: 1 + TV_SHELF.speaker, top: 1 + TV_SHELF.ledge + TV_SHELF.rail, h: 44 } as const;

/** `tvframe/shelf`: ledge + front face with both speaker cabinets and a 4 px-wide slot that stretches. */
function shelf(): UiFrame {
  const S = TV_SHELF, slotW = 4;
  const half = slotW / 2 + S.speaker;
  const W = 1 + 2 * half + 1, H = SHELF_H;
  const faceH = H - 2 - S.ledge;
  const slot = { x: -slotW / 2, y: S.rail, w: slotW, h: 44 };
  const img = new Uint8Array(W * H);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      // Ledge top: a shade line where it meets the bezel, then highlight (as in the room).
      const p = y <= S.ledge ? (y === 1 ? (["wood", 2] as const) : (["wood", 0] as const)) : shelfPaint(x - 1 - half, y - 1 - S.ledge, half, faceH, slot);
      img[y * W + x] = colorIndex(p[0], p[1]);
    }
  }
  addOutline(img, W, H);
  // Slices keep everything but the slot's 2 flat middle columns and one row, so only the slot stretches (sideways).
  const top = Math.floor((H - 1) / 2);
  return { key: "tvframe/shelf", w: W, h: H, img, ax: 0, ay: 0, borders: { left: 1 + S.speaker + 1, top, right: 1 + S.speaker + 1, bottom: H - 1 - top }, slice: true };
}

export function buildTvFrames(): UiFrame[] {
  return [bezel(), shelf()];
}

const u = (n: number): string => (n === 0 ? "0" : `calc(${String(n)} * var(--ui-px))`);

/** TV rules appended to `ui/reference.css`. */
export function tvCss(): string {
  const b = bezel().borders, sh = shelf().borders;
  if (!b || !sh) throw new Error("tv slices lost their borders");
  const sides = (x: { top: number; right: number; bottom: number; left: number }): string => `${u(x.top)} ${u(x.right)} ${u(x.bottom)} ${u(x.left)}`;
  const slices = (x: { top: number; right: number; bottom: number; left: number }): string => `${String(x.top)} ${String(x.right)} ${String(x.bottom)} ${String(x.left)}`;
  return `
/* ---- M1b TV frame (OME-92): the room's tv/0 bezel + media shelf as DOM, for a player outside the scaled stage. ----
 * <div class="ui-tv">
 *   <div class="ui-tv-bezel"><iframe …></iframe></div>      <- the iframe is the content box; nothing overlaps it
 *   <div class="ui-tv-shelf"><div class="ui-transport">…</div></div>
 * </div>
 * Use --ui-px: 1px (room scale). Below ~${String(356 + 2 * b.left)} CSS px, add .compact: the bezel keeps only its top and bottom bars and the
 * shelf only its slot, so a 356 px player still fits a 360 px viewport. The border-image width is the border width
 * (no "/ width"), so a zero side border draws no side slice: nothing is ever painted over the iframe. */
.ui-tv { display: flex; flex-direction: column; align-items: center; width: fit-content; image-rendering: pixelated; }
.ui-tv-bezel { box-sizing: content-box; border-style: solid; border-color: transparent; border-width: ${sides(b)}; border-image: url("slices/tvframe-bezel.png") ${slices(b)} stretch; line-height: 0; }
.ui-tv-bezel > iframe { display: block; border: 0; }
/* The shelf is wider than the bezel by its speakers; its slot is exactly the player's width. Fixed height: only the slot stretches. */
.ui-tv-shelf { position: relative; box-sizing: border-box; height: ${u(SHELF_H)}; width: calc(100% + ${u(sh.left + sh.right - 2 - b.left - b.right)}); margin-top: ${u(-1)}; border-style: solid; border-color: transparent; border-width: ${sides(sh)}; border-image: url("slices/tvframe-shelf.png") ${slices(sh)} fill stretch; }
.ui-tv-shelf > .ui-transport { position: absolute; left: 0; right: 0; top: ${u(SHELF_SLOT.top - sh.top)}; height: ${u(SHELF_SLOT.h)}; padding: 0 ${u(6)}; box-sizing: border-box; }
.ui-tv.compact .ui-tv-bezel { border-left-width: 0; border-right-width: 0; }
.ui-tv.compact .ui-tv-shelf { width: 100%; border-left-width: 0; border-right-width: 0; }
.ui-tv.compact .ui-tv-shelf > .ui-transport { left: 0; right: 0; }
/* In the room (player inside the stage), put the transport straight on the painted slot: meta.omega.tv.controls. */
.ui-tv-slot { position: absolute; display: flex; align-items: center; box-sizing: border-box; padding: 0 ${u(6)}; }
`;
}
