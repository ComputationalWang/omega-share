// A render re-places every name tag and hit pad (stage.ts `restack`), mostly where each already is (OME-2219).

/**
 * Put `e`'s anchor at (x, y) and move it by (dx, dy). The anchor is `translate`, so room.css's centring and
 * readable-zoom scale stay in `transform` / `scale`.
 */
export function placeAt(e: HTMLElement, x: number, y: number, dx: number, dy: number): void {
  // Stub (red): writes every style every time.
  e.style.translate = `${String(x)}px ${String(y)}px`;
  e.style.marginLeft = `${String(dx)}px`;
  e.style.marginTop = `${String(dy)}px`;
}
