/**
 * Tray art for pieces with no `thumb/<id>/<colour>` in ui/edit.png (OME-2095, assets/README.md "Budget levers"): the piece's `se` frame
 * in furniture-v8.png, scaled down at runtime (pinned to the sheet by wall-screens.test.ts).
 */
export const V8_THUMBS: Readonly<Record<string, { readonly x: number; readonly y: number; readonly w: number; readonly h: number }>> = {
  wallscreen: { x: 76, y: 527, w: 62, h: 70 },
  projector: { x: 154, y: 0, w: 76, h: 119 },
};

/** The divisor n (≥ 2, so at most half size) that fits a frame in the slot's 44×40 cubby; whole, so pixels stay even. */
export const trayScale = (r: { readonly w: number; readonly h: number }): number => Math.max(2, Math.ceil(r.w / 44), Math.ceil(r.h / 40));
