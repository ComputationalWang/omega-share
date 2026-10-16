// A PixiJS sprite sheet from an atlas's frames and png, shared by the room and set (g) atlases (each its own lazy chunk).
import { ImageSource, Rectangle, Texture } from "pixi.js";

export interface Sheet {
  /** The frame's texture with its anchor, made on first use. */
  texture(key: string): Texture | undefined;
}

type Frames = Readonly<Record<string, { readonly frame: { x: number; y: number; w: number; h: number }; readonly anchor: { x: number; y: number } }>>;

/** The sheet, plus its decoded image for code that draws without Pixi (the theme effect's canvas). */
export async function loadSheet(frames: Frames, pngUrl: string): Promise<Sheet & { readonly image: HTMLImageElement }> {
  const img = new Image();
  img.src = pngUrl;
  await img.decode();
  const source = new ImageSource({ resource: img, scaleMode: "nearest" });
  const cache = new Map<string, Texture>();
  return {
    image: img,
    texture(key) {
      let t = cache.get(key);
      const f = frames[key];
      if (t === undefined && f !== undefined) {
        const { x, y, w, h } = f.frame;
        t = new Texture({ source, frame: new Rectangle(x, y, w, h), defaultAnchor: f.anchor });
        cache.set(key, t);
      }
      return t;
    },
  };
}

/** Load once; a failed load is forgotten so the next layout change can retry. */
export function once<T>(load: () => Promise<T>): () => Promise<T> {
  let loading: Promise<T> | null = null;
  return () =>
    (loading ??= load().catch((e: unknown) => {
      loading = null;
      throw e;
    }));
}
