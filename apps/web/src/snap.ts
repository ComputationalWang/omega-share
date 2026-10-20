// /snap (OME-1565): stub for the red commit.
export interface PolaroidLayout {
  readonly width: number;
  readonly height: number;
  readonly photo: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
  readonly band: { readonly y: number; readonly h: number };
  readonly title: { readonly x: number; readonly y: number };
  readonly date: { readonly x: number; readonly y: number };
}

export function snapFilename(_now: Date): string {
  return "";
}

export function polaroidLayout(_w: number, _h: number): PolaroidLayout {
  return { width: 0, height: 0, photo: { x: 0, y: 0, w: 0, h: 0 }, band: { y: 0, h: 0 }, title: { x: 0, y: 0 }, date: { x: 0, y: 0 } };
}
