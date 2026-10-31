/** The wall screens' tray thumbs: rects in furniture-v8.png (`thumb/<id>/<colour>`, not in ui/edit.png; pinned to the sheet by wall-screens.test.ts, OME-2069). */
export const V8_THUMBS: Readonly<Record<string, { readonly x: number; readonly y: number; readonly w: number; readonly h: number }>> = {
  wallscreen: { x: 426, y: 659, w: 31, h: 36 },
  projector: { x: 321, y: 650, w: 25, h: 38 },
};

/** Stub (red, OME-2095). */
export const trayScale = (_r: { readonly w: number; readonly h: number }): number => 1;
