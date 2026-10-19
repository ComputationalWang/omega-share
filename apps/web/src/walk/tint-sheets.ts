// Sheets an avatar's shirt tint (ADR 0053) and hair colour (OME-1438) can recolour: the motion atlas's three, the bare
// heads under an accessory (OME-1404) and the hat overlays, which keep the avatar sheets' palette slots. Textures are made
// on first use; a look (tint, hair) is one PLTE swap into one copy, made once per avatar and look in use.
import { ImageSource, Rectangle, Texture } from "pixi.js";
import { HAIR_COUNT, TINT_COUNT } from "@omega/shared";
import tintsJson from "../../../../assets/avatars/tints.json";
import type { FrameRects } from "./motion";
import { AVATAR_HAIRS, AVATAR_IDS, lookPatch, parseTints, retintPng } from "./tint";

export interface TintableSheets {
  /** The frame's texture with its anchor, made on first use; `avatar`'s frame in shirt `tint` and `hair` once `loadTint` resolved. */
  texture(key: string, avatar?: number, tint?: number, hair?: number): Texture | undefined;
  /** Whether `texture` gives `avatar`'s frames in `tint` and `hair` yet (the shipped look always). */
  readonly ready: (avatar: number, tint: number, hair?: number) => boolean;
  /** Makes `avatar`'s sheets in shirt `tint` (ADR 0053) and `hair` (OME-1438), once; a failed load is forgotten so a later call can retry. */
  readonly loadTint: (avatar: number, tint: number, hair?: number) => Promise<void>;
}

async function source(img: HTMLImageElement | ImageBitmap): Promise<ImageSource> {
  if (img instanceof HTMLImageElement) await img.decode();
  return new ImageSource({ resource: img, scaleMode: "nearest" });
}

function image(url: string): HTMLImageElement {
  const img = new Image();
  img.src = url;
  return img;
}

interface Sheet {
  readonly rects: FrameRects;
  readonly src: ImageSource;
}

/** One set of sheets (the shipped one, or an avatar's tint): textures made on first use. */
function textures(sheets: readonly Sheet[]): (key: string) => Texture | undefined {
  const cache = new Map<string, Texture>();
  return (key) => {
    let t = cache.get(key);
    if (t !== undefined) return t;
    for (const { rects, src } of sheets) {
      const f = rects[key];
      if (f === undefined) continue;
      const { x, y, w, h } = f.frame;
      t = new Texture({ source: src, frame: new Rectangle(x, y, w, h), defaultAnchor: f.anchor });
      cache.set(key, t);
      return t;
    }
    return undefined;
  };
}

const look = (avatar: number, tint: number, hair: number): number => (avatar * TINT_COUNT + tint) * HAIR_COUNT + hair;

/** The sheets at `urls`, framed by `rects` (same order), decoded and ready to draw. */
export async function tintableSheets(urls: readonly string[], rects: readonly FrameRects[]): Promise<TintableSheets> {
  const tints = parseTints(tintsJson, AVATAR_IDS);
  const srcs = await Promise.all(urls.map((u) => source(image(u))));
  const base = textures(srcs.map((src, i) => ({ rects: rects[i] ?? {}, src })));
  // Per avatar × tint × hair (`look`): numeric, so the draw path allocates nothing.
  // shortcut: a look copies the whole sheets (~3.5 MB decoded for the motion atlas); crop to the avatar's own frames if rooms get big.
  const tinted: ((key: string) => Texture | undefined)[] = [];
  const loading = new Map<number, Promise<void>>();
  let bytes: Promise<Uint8Array[]> | null = null;
  const sheetBytes = (): Promise<Uint8Array[]> =>
    (bytes ??= Promise.all(urls.map(async (u) => new Uint8Array(await (await fetch(u)).arrayBuffer()))).catch((e: unknown) => {
      bytes = null;
      throw e;
    }));
  return {
    texture(key, avatar = 0, tint = 0, hair = 0) {
      return (tint === 0 && hair === 0 ? undefined : tinted[look(avatar, tint, hair)]?.(key)) ?? base(key);
    },
    ready: (avatar, tint, hair = 0) => (tint === 0 && hair === 0) || tinted[look(avatar, tint, hair)] !== undefined,
    loadTint(avatar, tint, hair = 0) {
      const i = look(avatar, tint, hair);
      const { slots, colors } = lookPatch(tints, AVATAR_HAIRS, avatar, tint, hair);
      if (slots.length === 0 || tinted[i] !== undefined) return Promise.resolve();
      let p = loading.get(i);
      if (p === undefined) {
        p = sheetBytes()
          .then((all) => Promise.all(all.map(async (png) => source(await createImageBitmap(new Blob([retintPng(png, slots, colors)], { type: "image/png" }))))))
          .then((s) => {
            tinted[i] = textures(s.map((src, n) => ({ rects: rects[n] ?? {}, src })));
          })
          .finally(() => loading.delete(i));
        loading.set(i, p);
      }
      return p;
    },
  };
}
