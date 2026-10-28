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
 * The part of the stage the page shows (OME-1050): full width, from 60 px (headroom for bubbles over the tallest wall
 * art, whose top is y 113) down past the caption rail (y 588). The rest is empty, so layouts fit this, not 960×600.
 */
export const ROOM_VIEW: Rect = { x: 0, y: 60, w: STAGE_W, h: 532 };

/** The scaled stage's CSS transform (`transform-origin: 0 0`): ROOM_VIEW's top-left lands on its clip's. */
export function stageTransform(scale: number): string {
  return `translate(${String(-ROOM_VIEW.x * scale)}px, ${String(-ROOM_VIEW.y * scale)}px) scale(${String(scale)})`;
}

/**
 * YouTube's Required Minimum Functionality: the player is at least 200×200 CSS px and nothing
 * of ours covers it. So the TV lives outside the scaled stage, at 16:9 and never below 356×200.
 */
const TV_MIN_W = 356;
/** Twitch: "Embedded video windows must be at least 400x300 pixels" (research M2 §2.1) → 534×300 at 16:9. */
const TWITCH_TV_MIN_W = 534;
const TV_MAX_W = 560;
/** YouTube's own floor is 200×200 (ADR 0012 amendment, OME-1302): narrower than TV_MIN_W the TV takes the screen's width
 * and keeps 200 px of height (the player letterboxes), so a 320 px phone never scrolls sideways. Twitch's can't shrink. */
const RMF_MIN = 200;
const minTvW = (provider: Provider | null, room: number): number => (provider === "twitch" ? TWITCH_TV_MIN_W : Math.min(TV_MIN_W, room));
const tvH = (w: number): number => Math.max(RMF_MIN, Math.round((w * 9) / 16));
/** Room for the TV's bezel, painted outside the player rect (`.ui-tv-frame`, border-image-outset). */
const TV_BEZEL = 6;
/** The media shelf's speakers, painted outside the control bar each side (`.ui-tv-shelf`). */
const SHELF_SPEAKER = 38;
const GAP = 8;
/** The shelf's width at 1× for its keys and a usable seek bar; Twitch's also holds the quality key and a 1:00:00 time. */
const SHELF_MIN_W = 420;
const TWITCH_SHELF_MIN_W = 560;
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

/**
 * Set (k) phone watch layout (OME-596): at most this wide, or any portrait screen (a tablet held upright gets the phone's
 * dock at its size, OME-1802, design OME-1799 §2 "medium"), the room page stacks TV, room and chat, with no editor.
 */
export const PHONE_MAX_W = 600;
export const PORTRAIT_QUERY = "(orientation: portrait)";
export const PHONE_QUERY = `(max-width: ${String(PHONE_MAX_W)}px), ${PORTRAIT_QUERY}`;
/** The phone's room window: the stage at 1× (until the viewer zooms it, OME-1184), cropped to this height (set k: "cropped to the seats"). */
export const PHONE_ROOM_H = 270;
/** The portrait room window is at least this tall (its row of zoom keys and a strip of room) or not shown (OME-1302). */
export const PHONE_ROOM_MIN_H = 96;
/** Medium's TV: the width minus 24 px a side, at most 720 (design OME-1799 §2). */
const MEDIUM_TV_MAX_W = 720;
const MEDIUM_GUTTER = 24;

/**
 * `provider`: the room's embed, for its minimum player size (ADR 0012; Twitch's is larger).
 * `phone`: set (k)'s watch layout. The TV is full width (still never under its minimum), bezel and shelf compact, and
 * `stage` is a window onto the unscaled stage, as wide as the container and PHONE_ROOM_H tall (`panTo` picks the view).
 */
export function roomLayout(containerWidth: number, provider: Provider | null = null, phone = false): RoomLayout {
  const width = Math.floor(containerWidth);
  const min = minTvW(provider, width);
  if (phone) {
    // Medium (a tablet held upright, OME-1846, design OME-1799 §2): the TV between gutters, at most MEDIUM_TV_MAX_W.
    const w = Math.max(min, width > PHONE_MAX_W ? Math.min(MEDIUM_TV_MAX_W, width - 2 * MEDIUM_GUTTER) : width);
    const x = Math.max(0, Math.floor((width - w) / 2));
    const tv = { x, y: TV_BEZEL, w, h: tvH(w) };
    // Twitch's TV can be wider than the screen (it scrolls sideways); the shelf stays on screen (QA OME-1870).
    const controls = { x, y: tv.y + tv.h + GAP, w: Math.min(w, width), h: CONTROL_BAR_H };
    const stage = { x: 0, y: controls.y + controls.h + GAP, w: Math.min(width, STAGE_W), h: PHONE_ROOM_H };
    return { tv, controls, stage, scale: 1, height: stage.y + stage.h, compact: { tv: true, controls: true } };
  }
  const tvW = Math.max(min, Math.min(TV_MAX_W, width - 2 * TV_BEZEL));
  const tv = { x: Math.max(0, Math.floor((width - tvW) / 2)), y: TV_BEZEL, w: tvW, h: tvH(tvW) };
  const controls = { x: tv.x, y: tv.y + tv.h + GAP, w: tv.w, h: CONTROL_BAR_H };
  const scale = Math.min(1, width / STAGE_W);
  const stage = { x: 0, y: controls.y + controls.h + GAP, w: ROOM_VIEW.w * scale, h: ROOM_VIEW.h * scale };
  const compact = { tv: !sidesFit(tv, TV_BEZEL, width), controls: !sidesFit(controls, SHELF_SPEAKER, width) };
  return { tv, controls, stage, scale, height: stage.y + stage.h, compact };
}

/** Portrait keeps the room inside the available box: a whole window (PHONE_ROOM_MIN_H) or none, never a sliver. */
export function portraitLayout(width: number, height: number, provider: Provider | null, typing: boolean): RoomLayout {
  const base = roomLayout(width, provider, true);
  const y = typing ? base.tv.y + base.tv.h : base.stage.y;
  return { ...base, controls: typing ? { ...base.controls, h: 0 } : base.controls,
    stage: { ...base.stage, y, h: typing || height - y < PHONE_ROOM_MIN_H ? 0 : height - y }, height };
}

/**
 * Desktop wide layout (OME-642): at least this wide and landscape, the room page is two columns, the TV, its shelf and
 * the room on the left and the chat (with Up next) in a full-height column on the right, WIDE_CHAT_W wide (style.css).
 */
const WIDE_MIN_W = 1024;
/** A phone held sideways (OME-1297): past the phone layout and at most this tall, two columns too, the chat column narrower (room.css). */
const SHORT_MAX_H = 500;
/** The two columns on a short screen (a phone held sideways): the chat column has no room for the owner's bar. */
export const SHORT_QUERY = `(max-height: ${String(SHORT_MAX_H)}px)`;
export const WIDE_QUERY = `(min-width: ${String(WIDE_MIN_W)}px) and (orientation: landscape), (min-width: ${String(PHONE_MAX_W + 1)}px) and (max-height: ${String(SHORT_MAX_H)}px) and (orientation: landscape)`;
export const WIDE_CHAT_W = 320;
/**
 * The TV's share of the left column's height once the shelf is taken off; the room gets the rest. OME-1050 (board): the
 * room is the larger part at 16:9; 0.37 still keeps a 1920×1080 window's TV above the stacked page's 560 px.
 */
const WIDE_TV_SHARE = 0.37;
/**
 * OME-1803 (design OME-1799 §2): with a video loaded the TV is the hero and the room an audience band under the shelf,
 * at least this tall and BAND_SHARE of the column. An empty room keeps the room-first split above.
 */
const BAND_MIN_H = 240;
const BAND_SHARE = 0.28;

/**
 * The wide room page's chrome zoom (OME-1667, board: "scalings on 2k"): 1× below 1920×900, 1.5× from there, 2× from
 * 2560×1200, so the chrome is 1280×600's or larger, only zoomed, and every key is at least 40 px. room.css zooms all of
 * it but the stage, which scales itself, and the shelf, which room-layout.ts zooms.
 */
export function chromeZoom(width: number, height: number): number {
  if (width >= 2560 && height >= 1200) return 2;
  return width >= 1920 && height >= 900 ? 1.5 : 1;
}

/**
 * The room's largest scale in a `width`×`height` window (OME-1811, design OME-1799 §2): whole numbers only, 1× or 2×
 * (STYLE.md, nearest-neighbour), never a fraction. 2× from 2400×1300; wideLayout drops it to 1× in a short band.
 */
export function roomScale(width: number, height: number): number {
  return width >= 2400 && height >= 1300 ? 2 : 1;
}

/**
 * The wide layout's left column, `width`×`height` CSS px: the TV (16:9, never under its ADR 0012 minimum, Twitch's is
 * larger), the shelf right under it, and the room's band below. `chrome` is the page's zoom (chromeZoom): the shelf's
 * height and minimum width grow with it. The room is at `maxScale` (roomScale) where the band holds BAND_MIN_H per scale
 * step, else 1× (OME-1811): `stage` is the band's window onto it, centred, and the whole room where it fits. The band's
 * backdrop reaches the column's edges past it (OME-1843, room-layout.ts).
 */
export function wideLayout(width: number, height: number, provider: Provider | null, chrome = 1, maxScale = 1): RoomLayout {
  const w = Math.floor(width);
  const h = Math.floor(height);
  const min = provider === "twitch" ? TWITCH_TV_MIN_W : TV_MIN_W;
  const barH = CONTROL_BAR_H * chrome;
  const rest = Math.max(0, h - (TV_BEZEL + GAP + barH + GAP));
  const split = rest * WIDE_TV_SHARE;
  const tvFit = provider === null ? split : Math.max(split, rest - Math.max(BAND_MIN_H, h * BAND_SHARE));
  const tvW = Math.max(min, Math.min(w - 2 * TV_BEZEL, Math.floor((tvFit * 16) / 9)));
  const tv = { x: Math.max(0, Math.floor((w - tvW) / 2)), y: TV_BEZEL, w: tvW, h: Math.round((tvW * 9) / 16) };
  // A TV narrower than the zoomed shelf's keys (People open, QA OME-1696) gets a wider shelf, centred under it. 1× as before.
  const keysW = chrome > 1 ? (provider === "twitch" ? TWITCH_SHELF_MIN_W : SHELF_MIN_W) * chrome : 0;
  const cw = Math.max(tv.w, Math.min(w, keysW));
  const controls = { x: Math.max(0, Math.floor(tv.x + (tv.w - cw) / 2)), y: tv.y + tv.h + GAP, w: cw, h: barH };
  const sy = controls.y + controls.h + GAP;
  const band = Math.max(0, h - sy);
  const scale = Math.max(1, Math.min(maxScale, Math.floor(band / BAND_MIN_H)));
  const sw = Math.min(w, ROOM_VIEW.w * scale);
  const stage = { x: Math.floor((w - sw) / 2), y: sy, w: sw, h: Math.min(band, ROOM_VIEW.h * scale) };
  const compact = { tv: !sidesFit(tv, TV_BEZEL, w), controls: !sidesFit(controls, SHELF_SPEAKER, w) };
  return { tv, controls, stage, scale, height: stage.y + stage.h, compact };
}

/** Full screen (OME-597, set k `ui-m7-desktop`): the chat strip's width beside the picture, and on a small landscape screen. */
export const FS_STRIP_W = 300;
/** A phone held sideways (OME-905): the frame, a 140 px field, the gap and the 44 px send key; 568 px still keeps a 356 px picture. */
const FS_STRIP_NARROW_W = 208;
/** Below this width a 300 px strip would take too much of the picture (a phone held sideways). */
const FS_STRIP_WIDE_FROM = 1000;
/** The band's transport (set k `ui-m7-band`: `flex: 0 1 560px`). */
const FS_BAND_TRANSPORT_W = 560;
/** The band's field and keys (OME-905): the frame, the emote key, a field with ≥ 60 % of its row, send, show-chat. */
const FS_BAND_FIELD_MIN = 304;
/** Narrower than this the transport can't give the field its room: the field moves to its own bar under the shelf. */
const FS_BAND_TRANSPORT_MIN = 280;
/** Short phones use a horizontally scrolling shelf when even the usual compact transport cannot fit. */
const FS_BAND_SCROLL_MIN = 240;

/** Chat hidden (OME-1491): the narrowest bubbles' column worth showing. */
const FS_BUBBLES_NARROW_W = 160;
/** The hide/show-chat handle's touch target (OME-1593). */
const FS_HANDLE = 44;
/** With the chat hidden the screen's bottom rows stay ours (OME-1668): a pointer pushed to the edge reaches the page. */
const FS_PEEK_EDGE = 8;

export type StripMode = "open" | "band";

/**
 * Full screen in `width`×`height` CSS px. `at`: "side" (strip open beside the picture, landscape), "below" (strip open
 * under the picture, portrait or too narrow for both), "band" (collapsed to one bar under the picture).
 * `strip`: the strip's box, or in "band" the field and keys after the transport. The picture keeps 16:9, its ADR 0012
 * minimum (Twitch's is larger), and the largest size that leaves the strip or band clear; nothing overlaps.
 */
export interface FullscreenLayout {
  /** Initial viewport scroll when the provider minimum and touch band need more vertical space. */
  readonly scrollY?: number;
  /** "alone": the room is popped out (OME-600), so the chat is in its window and the picture has the screen.
   * "hidden": the viewer hid the chat (OME-1491, OME-1593): no shelf, the largest centred picture, bubbles where room is left. */
  readonly at: "side" | "below" | "band" | "alone" | "hidden";
  readonly tv: Rect;
  readonly controls: Rect;
  readonly strip: Rect;
  readonly compact: { readonly tv: boolean; readonly controls: boolean };
  /** The hide/show-chat handle (OME-1593), 44 px: on the open strip's edge, or the screen's while hidden. `arrow`: where tapping moves the chat. */
  readonly handle?: Rect & { readonly arrow: "left" | "right" | "up" | "down" };
}

export function fullscreenLayout(width: number, height: number, provider: Provider | null, strip: StripMode | "none" | "hidden"): FullscreenLayout {
  const w = Math.floor(width);
  const h = Math.floor(height);
  const min = minTvW(provider, w);
  const below = GAP + CONTROL_BAR_H;
  /** The largest 16:9 picture in aw×ah, never under the minimum. */
  const fitTv = (aw: number, ah: number): { w: number; h: number } => {
    const tw = Math.max(min, Math.min(aw, Math.floor((ah * 16) / 9)));
    return { w: tw, h: tvH(tw) };
  };
  /** The shelf under the picture, its speakers inside the picture's width when they fit. */
  const shelf = (tv: Rect): Rect => {
    const fits = tv.w - 2 * SHELF_SPEAKER >= TV_MIN_W;
    return fits
      ? { x: tv.x + SHELF_SPEAKER, y: tv.y + tv.h + GAP, w: tv.w - 2 * SHELF_SPEAKER, h: CONTROL_BAR_H }
      : { x: tv.x, y: tv.y + tv.h + GAP, w: tv.w, h: CONTROL_BAR_H };
  };
  const compactOf = (controls: Rect, tv: Rect): { tv: boolean; controls: boolean } => ({ tv: true, controls: controls.w === tv.w });

  if (strip === "hidden") {
    // Really full screen (OME-1593): the largest 16:9 picture, centred. Nothing of ours over the player (ADR 0012), so the
    // show-chat handle keeps a 44 px margin on its edge and the opposite one; a phone's letterbox already holds it.
    // The bubbles get what the screen leaves beside (≥ 160 px) or under the picture, clear of the handle.
    if (w > h) {
      const pic = fitTv(w - 2 * FS_HANDLE, h - FS_PEEK_EDGE);
      const tv = { x: Math.max(0, Math.floor((w - pic.w) / 2)), y: Math.max(0, Math.min(Math.floor((h - pic.h) / 2), h - FS_PEEK_EDGE - pic.h)), ...pic };
      const sx = tv.x + tv.w;
      const sw = w - FS_HANDLE - sx;
      return { at: "hidden", tv, controls: { x: 0, y: 0, w: 0, h: 0 }, strip: { x: sx, y: 0, w: sw >= FS_BUBBLES_NARROW_W ? sw : 0, h },
        handle: { x: w - FS_HANDLE, y: Math.floor(h / 2 - FS_HANDLE / 2), w: FS_HANDLE, h: FS_HANDLE, arrow: "left" }, compact: { tv: true, controls: true } };
    }
    const pic = fitTv(w, h - 2 * FS_HANDLE);
    const tv = { x: Math.max(0, Math.floor((w - pic.w) / 2)), y: Math.max(0, Math.floor((h - pic.h) / 2)), ...pic };
    const sy = tv.y + tv.h;
    return { at: "hidden", tv, controls: { x: 0, y: 0, w: 0, h: 0 }, strip: { x: 0, y: sy, w, h: Math.max(0, h - FS_HANDLE - sy) },
      handle: { x: Math.floor(w / 2 - FS_HANDLE / 2), y: h - FS_HANDLE, w: FS_HANDLE, h: FS_HANDLE, arrow: "up" }, compact: { tv: true, controls: true } };
  }

  if (strip === "none") {
    const pic = fitTv(w, h - below);
    const tv = { x: Math.max(0, Math.floor((w - pic.w) / 2)), y: Math.max(0, Math.floor((h - pic.h - below) / 2)), ...pic };
    const controls = shelf(tv);
    return { at: "alone", tv, controls, strip: { x: 0, y: 0, w: 0, h: 0 }, compact: compactOf(controls, tv) };
  }

  if (strip === "band") {
    const bandH = w < FS_STRIP_WIDE_FROM ? CONTROL_BAR_H + 4 : CONTROL_BAR_H;
    const bx = SHELF_SPEAKER;
    const bw = w - 2 * SHELF_SPEAKER;
    const half = Math.min(FS_BAND_TRANSPORT_W, Math.floor(bw / 2));
    // Half and half where the field has its room; on a phone held sideways the transport gives way to it.
    const cw = Math.min(half, bw - SHELF_SPEAKER - FS_BAND_FIELD_MIN);
    // Portrait, or too narrow for both on one bar: the shelf, then the field on its own bar under it.
    const stacked = (w < FS_STRIP_WIDE_FROM && h > w) || cw < FS_BAND_TRANSPORT_MIN;
    // A second row cannot fit under Twitch's 300 px minimum on short phones. Drop the shelf's
    // speaker outsets and share one row instead; keep the composer's 44 px content plus its frame.
    const compactBandH = CONTROL_BAR_H + 4;
    const minTvH = tvH(min);
    if (minTvH + below + GAP + bandH > h
      && h >= compactBandH
      && w >= FS_BAND_SCROLL_MIN + GAP + FS_BAND_FIELD_MIN) {
      const pic = fitTv(w, h - GAP - compactBandH);
      const tv = { x: Math.max(0, Math.floor((w - pic.w) / 2)), y: 0, ...pic };
      const y = tv.h + GAP;
      const controls = { x: 0, y, w: Math.min(FS_BAND_TRANSPORT_MIN, w - GAP - FS_BAND_FIELD_MIN), h: CONTROL_BAR_H };
      const sx = controls.w + GAP;
      return { at: "band", tv, controls, strip: { x: sx, y, w: w - sx, h: compactBandH },
        scrollY: Math.max(0, y + compactBandH - h), compact: { tv: true, controls: true } };
    }
    const under = stacked ? below + GAP + bandH : GAP + bandH;
    const pic = fitTv(w, h - under);
    const tv = { x: Math.max(0, Math.floor((w - pic.w) / 2)), y: Math.max(0, Math.floor((h - pic.h - under) / 2)), ...pic };
    const y = tv.y + tv.h + GAP;
    if (stacked) {
      const controls = { x: 0, y, w, h: CONTROL_BAR_H };
      const sy = y + CONTROL_BAR_H + GAP;
      return { at: "band", tv, controls, strip: { x: 0, y: sy, w, h: bandH },
        scrollY: Math.max(0, sy + bandH - h), compact: { tv: true, controls: true } };
    }
    const controls = { x: bx, y, w: cw, h: CONTROL_BAR_H };
    // The shelf's right speaker is painted outside the transport box: the field starts after it.
    const sx = controls.x + controls.w + SHELF_SPEAKER;
    return { at: "band", tv, controls, strip: { x: sx, y, w: bx + bw - sx, h: bandH }, compact: { tv: true, controls: cw < half } };
  }

  // The preferred 208 px strip can give up its spare pixels when that keeps Twitch beside it.
  // 201 px still leaves the frame, a 140 px field, a 4 px gap and the 44 px send key.
  const stripW = w >= FS_STRIP_WIDE_FROM ? FS_STRIP_W : Math.min(FS_STRIP_NARROW_W, Math.max(201, w - min));
  const aw = w - stripW;
  // Keep the picture stable when collapsing into a phone band with its 4 px composer frame.
  const sideBelow = below + (w < FS_STRIP_WIDE_FROM ? 4 : 0);
  const side = w > h && aw >= min && h - sideBelow >= tvH(min);
  if (side) {
    const pic = fitTv(aw, h - sideBelow);
    const tv = { x: Math.max(0, Math.floor((aw - pic.w) / 2)), y: Math.max(0, Math.floor((h - pic.h - sideBelow) / 2)), ...pic };
    const controls = shelf(tv);
    return { at: "side", tv, controls, strip: { x: aw, y: 0, w: stripW, h }, compact: compactOf(controls, tv),
      handle: { x: aw, y: Math.floor(h / 2 - FS_HANDLE / 2), w: FS_HANDLE, h: FS_HANDLE, arrow: "right" } };
  }
  // Reserve the open strip's header, composer and frame before sizing a below-player picture.
  const openStripH = 112;
  const minTvH = tvH(min);
  // Short landscape cannot hold the provider minimum plus an open strip. Show a compact band
  // until more space is available; the caller keeps the user's remembered open preference.
  // Below 356 px Twitch also needs vertical scrolling: its intact player stays above the band.
  if (w > h && h < minTvH + below + GAP + openStripH
    && h >= CONTROL_BAR_H + 4
    && w >= FS_BAND_FIELD_MIN) {
    return fullscreenLayout(w, h, provider, "band");
  }
  const pic = fitTv(w, h - below - GAP - openStripH);
  const tv = { x: Math.max(0, Math.floor((w - pic.w) / 2)), y: 0, ...pic };
  const controls = { x: 0, y: tv.h + GAP, w, h: CONTROL_BAR_H };
  const sy = controls.y + controls.h + GAP;
  return { at: "below", tv, controls, strip: { x: 0, y: sy, w, h: Math.max(openStripH, h - sy) },
    scrollY: Math.max(0, sy + openStripH - h), compact: { tv: true, controls: true },
    handle: { x: Math.floor(w / 2 - FS_HANDLE / 2), y: sy, w: FS_HANDLE, h: FS_HANDLE, arrow: "down" } };
}

/** The whole-room window's chat column (set k `ui-m7-popout`, OME-600). */
const POP_ROOM_CHAT_W = 300;

export interface PopRoomLayout {
  /** The stage's box once scaled (window px), centred in the room side. */
  readonly stage: Rect;
  /** Fills the room side: up past 1× in a big window (OME-1050), down in a small one. */
  readonly scale: number;
  readonly chat: Rect;
}

/** The room window in `width`×`height` CSS px: the room on the left, the chat column on the right. */
export function popRoomLayout(width: number, height: number): PopRoomLayout {
  const w = Math.max(0, Math.floor(width));
  const h = Math.max(0, Math.floor(height));
  const cw = Math.min(POP_ROOM_CHAT_W, w);
  const aw = w - cw;
  const scale = Math.max(0.05, Math.min(aw / ROOM_VIEW.w, h / ROOM_VIEW.h));
  const sw = Math.floor(ROOM_VIEW.w * scale);
  const sh = Math.floor(ROOM_VIEW.h * scale);
  return {
    stage: { x: Math.max(0, Math.floor((aw - sw) / 2)), y: Math.max(0, Math.floor((h - sh) / 2)), w: sw, h: sh },
    scale,
    chat: { x: aw, y: 0, w: cw, h },
  };
}

/**
 * The top-left of a `view`-sized window onto the stage centred on `centre` (stage px), kept on the stage, whole pixels.
 * At `zoom` (OME-1184) the window covers `view / zoom` stage px.
 */
export function panTo(view: { readonly w: number; readonly h: number }, centre: Point, zoom = 1): Point {
  const w = view.w / zoom;
  const h = view.h / zoom;
  const clamp = (v: number, max: number): number => Math.max(0, Math.min(Math.max(0, max), Math.round(v)));
  return { x: clamp(centre.x - w / 2, STAGE_W - w), y: clamp(centre.y - h / 2, STAGE_H - h) };
}

/** A seat's touch hit area is 44 px tall (room.css .ui-touch .seat), centred on its point. */
const SEAT_HIT_H = 44;
/** A name tag's foot under its member's point (tagRect): the lowest thing a member shows. */
export const TAG_FOOT = 30;

/**
 * Where the room window looks first (stage px), `h` stage px tall: the middle of the points' bounding box (each from
 * its seat's hit area's top to `foot` under it), or in a window too short for every row (320×640, QA OME-1324 G3) the
 * front row with a pixel to spare, so those seats show whole and stay tappable instead of every row cropped
 * (room-window.ts makes a cropped seat inert). The phone's window: the seats, to their hit areas' foot. The desktop band
 * (OME-1843): the seats and standing spots, to their name tags' foot (TAG_FOOT).
 */
export function seatsHome(points: readonly Point[], h: number, foot = SEAT_HIT_H / 2): Point {
  if (points.length === 0) return { x: STAGE_W / 2, y: STAGE_H / 2 };
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of points) {
    x0 = Math.min(x0, p.x);
    x1 = Math.max(x1, p.x);
    y0 = Math.min(y0, p.y);
    y1 = Math.max(y1, p.y);
  }
  const top = y0 - SEAT_HIT_H / 2;
  const bottom = y1 + foot;
  return { x: (x0 + x1) / 2, y: bottom - top <= h ? (top + bottom) / 2 : bottom + 1 - h / 2 };
}

/**
 * Where the desktop band looks first (OME-1843): the whole audience, seats and standing spots, to their name tags' foot.
 * A band too short for every name tag keeps the seats whole instead, where they fit (OME-1864): Twitch's taller TV and
 * its hint leave 1280×720 a band where the audience's front row put the back seats behind the TV, out of every click's
 * reach. Where the tags fit (the Theatre at 1280×800), or the seats don't either, it's OME-1843's home.
 */
export function bandHome(seats: readonly Point[], standing: readonly Point[], h: number): Point {
  const audience = [...seats, ...standing];
  const tagsFit = span(audience, TAG_OFFSET_Y) <= h;
  if (tagsFit || seats.length === 0 || span(seats, -SEAT_HIT_H / 2) > h) return seatsHome(audience, h, TAG_FOOT);
  // The seats whole, and from there as near the audience's home as the band goes (OME-1945): centred on the seats, the
  // Dank Dungeon's band cut the first standing spot's tag by 2 px.
  const ys = seats.map((p) => p.y);
  const lo = Math.max(...ys) + TAG_FOOT - h / 2;
  const hi = Math.min(...ys) - SEAT_HIT_H / 2 + h / 2;
  return { x: seatsHome(seats, h, TAG_FOOT).x, y: Math.max(lo, Math.min(hi, seatsHome(audience, h, TAG_FOOT).y)) };
}

/** A standing avatar's head above its point (walk/animator.ts EMOTE_LIFT.idle): the highest thing it shows. */
export const AVATAR_TOP = 60;

/**
 * The touch window's home (OME-1930), a `view` stage px: the seats' (seatsHome) and, while I stand, me too, head to my
 * widest name tag's foot: the middle of us all where the window holds it, else me (844×390's 120 px). The empty standing
 * spots don't count: on a phone they pulled the seats out of the window (OME-1612). Seated, the window looks at my seat
 * (RoomLayout.centre).
 */
export function touchHome(seats: readonly Point[], me: Point | null, view: Size): Point {
  if (me === null) return seatsHome(seats, view.h);
  let x0 = me.x - TAG_MAX_W / 2, x1 = me.x + TAG_MAX_W / 2, y0 = me.y - AVATAR_TOP, y1 = me.y + TAG_FOOT;
  for (const p of seats) {
    x0 = Math.min(x0, p.x);
    x1 = Math.max(x1, p.x);
    y0 = Math.min(y0, p.y - SEAT_HIT_H / 2);
    y1 = Math.max(y1, p.y + SEAT_HIT_H / 2);
  }
  return { x: x1 - x0 <= view.w ? (x0 + x1) / 2 : me.x, y: y1 - y0 <= view.h ? (y0 + y1) / 2 : me.y + (TAG_FOOT - AVATAR_TOP) / 2 };
}

/** The points' rows, from `top` under the highest (a seat's hit area, or its name tag) to the lowest's tag foot. */
function span(points: readonly Point[], top: number): number {
  const ys = points.map((p) => p.y);
  return Math.max(...ys) + TAG_FOOT - (Math.min(...ys) + top);
}

interface Size { readonly w: number; readonly h: number }

/** The phone window's zoom range (OME-1184): from the whole stage on screen (never above 1×) up to this. */
export const MAX_ZOOM = 2;
export const minZoom = (view: Size): number => Math.min(1, view.w / STAGE_W, view.h / STAGE_H);
export const clampZoom = (z: number, view: Size): number => (Number.isFinite(z) ? Math.max(minZoom(view), Math.min(MAX_ZOOM, z)) : 1);

/** Zoomed out, names and bubbles are counter-scaled so they never show below this fraction of their 1× size. */
const LABEL_MIN = 0.85;
export const labelScale = (zoom: number): number => Math.max(1, LABEL_MIN / zoom);

/** The stored zoom is untrusted (anyone can edit localStorage): a positive finite number, or null. */
export function readZoom(s: string | null): number | null {
  const z = Number(s ?? "");
  return s !== null && s !== "" && Number.isFinite(z) && z > 0 ? z : null;
}

/**
 * A pinch that started at `start` (zoom, the stage point under the fingers' midpoint, the fingers' distance), now
 * `now` (distance, midpoint in window px): the zoom scales with the distance, and the start's stage point stays under
 * the midpoint. Returns the window's new centre (stage px) for `panTo`.
 */
export function pinchView(start: { readonly zoom: number; readonly at: Point; readonly dist: number }, now: { readonly dist: number; readonly mid: Point }, view: Size): { zoom: number; centre: Point } {
  const zoom = clampZoom(start.dist > 0 ? (start.zoom * now.dist) / start.dist : start.zoom, view);
  return { zoom, centre: { x: start.at.x - now.mid.x / zoom + view.w / (2 * zoom), y: start.at.y - now.mid.y / zoom + view.h / (2 * zoom) } };
}

/** The desktop room's zoom (OME-1490): a multiple of its fitted scale, and its view's top-left (stage px). */
export interface DeskView {
  readonly zoom: number;
  readonly pan: Point;
}

/**
 * The desktop wheel (OME-1490): the room fitted at `fit`, zoomed from `from` to `zoom` (clamped from the fit, 1, to
 * MAX_ZOOM) around `at` (px in the room's box): the stage point under `at` stays under it, and the view stays in ROOM_VIEW.
 * `view` is the room's box (CSS px): ROOM_VIEW at `fit`, or a band smaller than that (OME-1811).
 */
export function wheelView(fit: number, from: DeskView, at: Point, zoom: number, view: Size = { w: ROOM_VIEW.w * fit, h: ROOM_VIEW.h * fit }): DeskView {
  const z = Number.isFinite(zoom) ? Math.max(1, Math.min(MAX_ZOOM, zoom)) : 1;
  const k0 = fit * from.zoom;
  const k1 = fit * z;
  const clamp = (v: number, lo: number, span: number, shown: number): number => Math.max(lo, Math.min(lo + Math.max(0, span - shown / k1), v));
  return { zoom: z, pan: { x: clamp(from.pan.x + at.x / k0 - at.x / k1, ROOM_VIEW.x, ROOM_VIEW.w, view.w), y: clamp(from.pan.y + at.y / k0 - at.y / k1, ROOM_VIEW.y, ROOM_VIEW.h, view.h) } };
}

/** A stage-space rect on the page. */
export function stageToPage(l: RoomLayout, r: Rect): Rect {
  return { x: l.stage.x + (r.x - ROOM_VIEW.x) * l.scale, y: l.stage.y + (r.y - ROOM_VIEW.y) * l.scale, w: r.w * l.scale, h: r.h * l.scale };
}

/** Name tags hang below the avatar's feet; `style.css` caps them at this box. */
export const TAG_OFFSET_Y = 10;
const TAG_MAX_W = 160;
const TAG_H = 20;
/** Bubbles float above the head, bottom-anchored; `style.css` caps them at this box. */
const BUBBLE_OFFSET_Y = -48;
const BUBBLE_MAX_W = 220;
const BUBBLE_MAX_H = 180;

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

/** Placeholder avatar colours: drawn until the motion atlas loads, or for good if it fails to load. */
export const AVATAR_COLORS: readonly number[] = [0xe4572e, 0x29335c, 0xf3a712, 0x669bbc];

/** The moments strip's height (OME-1628): its 14 px pips over a 3 px bar. */
export const MOMENTS_H = 18;

/**
 * The moments strip's box (OME-1628): right under the shelf, as wide as the picture, so a pip's `left: %` is the
 * player's. In the page it hangs over the stage's top (ROOM_VIEW's wall headroom). `null` where there is no room for it:
 * no shelf (full screen with the chat hidden), the chat under the shelf (full screen "below" and "band"), or off the wrap.
 */
export function momentsBox(l: { readonly tv: Rect; readonly controls: Rect }, height: number, fsAt?: FullscreenLayout["at"]): Rect | null {
  if (l.controls.w === 0 || fsAt === "below" || fsAt === "band" || fsAt === "hidden") return null;
  const y = l.controls.y + l.controls.h + 2;
  return y + MOMENTS_H > height ? null : { x: l.tv.x, y, w: l.tv.w, h: MOMENTS_H };
}
