// /snap and the camera key (OME-1565): a polaroid of the room, local only. The stage canvas is copied once at 2×
// nearest-neighbour into an offscreen canvas framed off-white, with the room title and date in the bottom band, and saved
// as a PNG. Only the canvas is read: name tags, bubbles and the video are DOM over or beside it, so they never show.
// Nothing is drawn per frame and nothing is uploaded.

export interface PolaroidLayout {
  readonly width: number;
  readonly height: number;
  readonly photo: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
  readonly band: { readonly y: number; readonly h: number };
  /** Text baselines in the band. */
  readonly title: { readonly x: number; readonly y: number };
  readonly date: { readonly x: number; readonly y: number };
}

const SCALE = 2;
const BORDER = 24;
const BAND = 96;
const PAPER = "#f6f1e7";
const INK = "#2b2620";

/** `omega-YYYY-MM-DD.png`, the local date. */
export function snapFilename(now: Date): string {
  return `omega-${dateText(now)}.png`;
}

function dateText(d: Date): string {
  const two = (n: number): string => String(n).padStart(2, "0");
  return `${String(d.getFullYear())}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

/** Where everything goes for a `w`×`h` canvas: the photo at 2× inside an even border, and a thicker band under it. */
export function polaroidLayout(w: number, h: number): PolaroidLayout {
  const photo = { x: BORDER, y: BORDER, w: w * SCALE, h: h * SCALE };
  const bandY = BORDER + photo.h;
  return {
    width: photo.w + BORDER * 2,
    height: bandY + BAND,
    photo,
    band: { y: bandY, h: BAND },
    title: { x: BORDER, y: bandY + 38 },
    date: { x: BORDER, y: bandY + 76 },
  };
}

/** Frame the canvas as it is now and save it as `omega-<date>.png`. */
export function snapRoom(scene: HTMLCanvasElement, title: string, now: Date): void {
  const l = polaroidLayout(scene.width, scene.height);
  const out = document.createElement("canvas");
  out.width = l.width;
  out.height = l.height;
  const ctx = out.getContext("2d");
  if (ctx === null) return;
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, l.width, l.height);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(scene, l.photo.x, l.photo.y, l.photo.w, l.photo.h);
  const font = getComputedStyle(document.body).fontFamily;
  const maxW = l.width - BORDER * 2;
  ctx.fillStyle = INK;
  ctx.font = `700 28px ${font}`;
  ctx.fillText(title, l.title.x, l.title.y, maxW);
  ctx.font = `20px ${font}`;
  ctx.fillText(dateText(now), l.date.x, l.date.y, maxW);
  out.toBlob((blob) => {
    if (blob === null) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = snapFilename(now);
    a.click();
    // The click has started the download; the URL can go on the next task.
    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 0);
  }, "image/png");
}
