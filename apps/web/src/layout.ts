import { FLOOR_CELLS, type Provider } from "@omega/shared";

/** Logical stage size; the DOM stage is CSS-scaled to fit, the canvas matches it 1:1. */
export const STAGE_W = 960;
export const STAGE_H = 600;

export const TILE_W = 64;
export const TILE_H = 32;
export { FLOOR_CELLS };
/** Screen position of the floor's back corner. */
const ORIGIN_X = STAGE_W / 2;
const ORIGIN_Y = 220;

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Centre of iso cell (col, row). */
export function cellCenter(col: number, row: number): Point {
  return { x: ORIGIN_X + (col - row) * (TILE_W / 2), y: ORIGIN_Y + (col + row + 1) * (TILE_H / 2) };
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * YouTube's Required Minimum Functionality: the player is at least 200×200 CSS px and nothing
 * of ours covers it. So the TV lives outside the scaled stage, at 16:9 and never below 356×200.
 */
const TV_MIN_W = 356;
/** Twitch: "Embedded video windows must be at least 400x300 pixels" (research M2 §2.1) → 534×300 at 16:9. */
const TWITCH_TV_MIN_W = 534;
const TV_MAX_W = 560;
/** Room for the TV's bezel, painted outside the player rect (`.ui-tv-frame`, border-image-outset). */
const TV_BEZEL = 6;
/** The media shelf's speakers, painted outside the control bar each side (`.ui-tv-shelf`). */
const SHELF_SPEAKER = 38;
const GAP = 8;
/** Set (e) chrome at 1×: 8 px panel border + 4 px padding around a 20 px key, top and bottom. */
export const CONTROL_BAR_H = 44;

/** Everything in container CSS px. `stage` is the scaled 960×600 stage's box on the page. */
export interface RoomLayout {
  readonly tv: Rect;
  readonly controls: Rect;
  readonly stage: Rect;
  readonly scale: number;
  readonly height: number;
  /** `.compact` on the TV frame / shelf: its side ink wouldn't fit in the container, so it's dropped. */
  readonly compact: { readonly tv: boolean; readonly controls: boolean };
}

const sidesFit = (r: Rect, side: number, width: number): boolean => r.x >= side && r.x + r.w + side <= width;

/** Set (k) phone watch layout (OME-596): at most this wide, the room page stacks TV, room and chat, with no editor. */
export const PHONE_MAX_W = 600;
export const PHONE_QUERY = `(max-width: ${String(PHONE_MAX_W)}px)`;
/** The phone's room window: the stage at 1×, cropped to this height (set k: "cropped to the seats"). */
export const PHONE_ROOM_H = 270;

/**
 * `provider`: the room's embed, for its minimum player size (ADR 0012; Twitch's is larger).
 * `phone`: set (k)'s watch layout. The TV is full width (still never under its minimum), bezel and shelf compact, and
 * `stage` is a window onto the unscaled stage, as wide as the container and PHONE_ROOM_H tall (`panTo` picks the view).
 */
export function roomLayout(containerWidth: number, provider: Provider | null = null, phone = false): RoomLayout {
  const width = Math.floor(containerWidth);
  const min = provider === "twitch" ? TWITCH_TV_MIN_W : TV_MIN_W;
  if (phone) {
    const w = Math.max(min, width);
    const tv = { x: 0, y: TV_BEZEL, w, h: Math.round((w * 9) / 16) };
    const controls = { x: 0, y: tv.y + tv.h + GAP, w, h: CONTROL_BAR_H };
    const stage = { x: 0, y: controls.y + controls.h + GAP, w: Math.min(width, STAGE_W), h: PHONE_ROOM_H };
    return { tv, controls, stage, scale: 1, height: stage.y + stage.h, compact: { tv: true, controls: true } };
  }
  const tvW = Math.max(min, Math.min(TV_MAX_W, width - 2 * TV_BEZEL));
  const tv = { x: Math.max(0, Math.floor((width - tvW) / 2)), y: TV_BEZEL, w: tvW, h: Math.round((tvW * 9) / 16) };
  const controls = { x: tv.x, y: tv.y + tv.h + GAP, w: tv.w, h: CONTROL_BAR_H };
  const scale = Math.min(1, width / STAGE_W);
  const stage = { x: 0, y: controls.y + controls.h + GAP, w: STAGE_W * scale, h: STAGE_H * scale };
  const compact = { tv: !sidesFit(tv, TV_BEZEL, width), controls: !sidesFit(controls, SHELF_SPEAKER, width) };
  return { tv, controls, stage, scale, height: stage.y + stage.h, compact };
}

/** Full screen (OME-597, set k `ui-m7-desktop`): the chat strip's width beside the picture, and on a small landscape screen. */
export const FS_STRIP_W = 300;
const FS_STRIP_NARROW_W = 160;
/** Below this width a 300 px strip would take too much of the picture (a phone held sideways). */
const FS_STRIP_WIDE_FROM = 1000;
/** The band's transport (set k `ui-m7-band`: `flex: 0 1 560px`). */
const FS_BAND_TRANSPORT_W = 560;

export type StripMode = "open" | "band";

/**
 * Full screen in `width`×`height` CSS px. `at`: "side" (strip open beside the picture, landscape), "below" (strip open
 * under the picture, portrait or too narrow for both), "band" (collapsed to one bar under the picture).
 * `strip`: the strip's box, or in "band" the field and keys after the transport. The picture keeps 16:9, its ADR 0012
 * minimum (Twitch's is larger), and the largest size that leaves the strip or band clear; nothing overlaps.
 */
export interface FullscreenLayout {
  readonly at: "side" | "below" | "band";
  readonly tv: Rect;
  readonly controls: Rect;
  readonly strip: Rect;
  readonly compact: { readonly tv: boolean; readonly controls: boolean };
}

export function fullscreenLayout(width: number, height: number, provider: Provider | null, strip: StripMode): FullscreenLayout {
  const w = Math.floor(width);
  const h = Math.floor(height);
  const min = provider === "twitch" ? TWITCH_TV_MIN_W : TV_MIN_W;
  const below = GAP + CONTROL_BAR_H;
  /** The largest 16:9 picture in aw×ah, never under the minimum. */
  const fitTv = (aw: number, ah: number): { w: number; h: number } => {
    const tw = Math.max(min, Math.min(aw, Math.floor((ah * 16) / 9)));
    return { w: tw, h: Math.round((tw * 9) / 16) };
  };
  /** The shelf under the picture, its speakers inside the picture's width when they fit. */
  const shelf = (tv: Rect): Rect => {
    const fits = tv.w - 2 * SHELF_SPEAKER >= TV_MIN_W;
    return fits
      ? { x: tv.x + SHELF_SPEAKER, y: tv.y + tv.h + GAP, w: tv.w - 2 * SHELF_SPEAKER, h: CONTROL_BAR_H }
      : { x: tv.x, y: tv.y + tv.h + GAP, w: tv.w, h: CONTROL_BAR_H };
  };
  const compactOf = (controls: Rect, tv: Rect): { tv: boolean; controls: boolean } => ({ tv: true, controls: controls.w === tv.w });

  if (strip === "band") {
    const pic = fitTv(w, h - below);
    const tv = { x: Math.max(0, Math.floor((w - pic.w) / 2)), y: Math.max(0, Math.floor((h - pic.h - below) / 2)), ...pic };
    const y = tv.y + tv.h + GAP;
    if (w < FS_STRIP_WIDE_FROM && h > w) {
      // Portrait: the shelf, then the field on its own bar.
      const controls = { x: 0, y, w, h: CONTROL_BAR_H };
      return { at: "band", tv, controls, strip: { x: 0, y: y + CONTROL_BAR_H + GAP, w, h: CONTROL_BAR_H }, compact: { tv: true, controls: true } };
    }
    const bx = SHELF_SPEAKER;
    const bw = w - 2 * SHELF_SPEAKER;
    const controls = { x: bx, y, w: Math.min(FS_BAND_TRANSPORT_W, Math.floor(bw / 2)), h: CONTROL_BAR_H };
    // The shelf's right speaker is painted outside the transport box: the field starts after it.
    const sx = controls.x + controls.w + SHELF_SPEAKER;
    return { at: "band", tv, controls, strip: { x: sx, y, w: bx + bw - sx, h: CONTROL_BAR_H }, compact: { tv: true, controls: false } };
  }

  const stripW = w >= FS_STRIP_WIDE_FROM ? FS_STRIP_W : FS_STRIP_NARROW_W;
  const aw = w - stripW;
  const side = w > h && aw >= min && h - below >= Math.round((min * 9) / 16);
  if (side) {
    const pic = fitTv(aw, h - below);
    const tv = { x: Math.max(0, Math.floor((aw - pic.w) / 2)), y: Math.max(0, Math.floor((h - pic.h - below) / 2)), ...pic };
    const controls = shelf(tv);
    return { at: "side", tv, controls, strip: { x: aw, y: 0, w: stripW, h }, compact: compactOf(controls, tv) };
  }
  // Portrait (or too narrow for both): the picture full width on top, the shelf, then the strip down to the bottom.
  const tw = Math.max(min, w);
  const tv = { x: 0, y: 0, w: tw, h: Math.round((tw * 9) / 16) };
  const controls = { x: 0, y: tv.h + GAP, w, h: CONTROL_BAR_H };
  const sy = controls.y + controls.h + GAP;
  return { at: "below", tv, controls, strip: { x: 0, y: sy, w, h: Math.max(0, h - sy) }, compact: { tv: true, controls: true } };
}

/** The top-left of a `view`-sized window onto the stage centred on `centre` (stage px), kept on the stage, whole pixels. */
export function panTo(view: { readonly w: number; readonly h: number }, centre: Point): Point {
  const clamp = (v: number, max: number): number => Math.max(0, Math.min(Math.max(0, max), Math.round(v)));
  return { x: clamp(centre.x - view.w / 2, STAGE_W - view.w), y: clamp(centre.y - view.h / 2, STAGE_H - view.h) };
}

/** A stage-space rect on the page. */
export function stageToPage(l: RoomLayout, r: Rect): Rect {
  return { x: l.stage.x + r.x * l.scale, y: l.stage.y + r.y * l.scale, w: r.w * l.scale, h: r.h * l.scale };
}

/** Name tags hang below the avatar's feet; `style.css` caps them at this box. */
export const TAG_OFFSET_Y = 10;
export const TAG_MAX_W = 160;
export const TAG_H = 20;
/** Bubbles float above the head, bottom-anchored; `style.css` caps them at this box. */
export const BUBBLE_OFFSET_Y = -48;
export const BUBBLE_MAX_W = 220;
export const BUBBLE_MAX_H = 180;

export function tagRect(p: Point): Rect {
  return { x: p.x - TAG_MAX_W / 2, y: p.y + TAG_OFFSET_Y, w: TAG_MAX_W, h: TAG_H };
}

export function bubbleRect(p: Point): Rect {
  return { x: p.x - BUBBLE_MAX_W / 2, y: p.y + BUBBLE_OFFSET_Y - BUBBLE_MAX_H, w: BUBBLE_MAX_W, h: BUBBLE_MAX_H };
}

/**
 * Chat system lines ("Ana paused"): a caption rail in the stage's empty bottom-left corner, stage px.
 * Room scale, up to MAX_SYSLINES lines, newest at the bottom; clear of every seat, standing spot and tag.
 */
export const SYSLINE_RAIL: Rect = { x: 12, y: 510, w: 288, h: 78 };

/** Placeholder avatar colours until the sprites land. */
export const AVATAR_COLORS: readonly number[] = [0xe4572e, 0x29335c, 0xf3a712, 0x669bbc];
export const cssColor = (c: number): string => `#${c.toString(16).padStart(6, "0")}`;
