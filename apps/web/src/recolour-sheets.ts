// The recoloured copies of furniture and room sheets (OME-1463, art OME-1462). Its own chunk: stage.ts imports it only when a
// layout uses a new colour. A copy is one PLTE swap of the source sheet's bytes (walk/tint.ts `retintPng`), made once per
// (kind, variant) in use; textures are made on first use, under `recolourKey` (recolours.ts).
import { ImageSource, Rectangle, Texture } from "pixi.js";
import type { FurnitureKind } from "@omega/shared";
import type { Frames, Sheet } from "./atlas-sheet";
import { recolourOf, recolourSource } from "./recolours";
import { retintPng } from "./walk/tint";

/** A loaded atlas a recolour copies: its png and frames. */
export interface SourceSheet {
  readonly url: string;
  readonly manifest: { readonly frames: Frames };
}

export interface RecolourSheets extends Sheet {
  /** Makes `kind`'s `variant` copy of `source`, once; a failed load is forgotten so a later call can retry. */
  load(kind: FurnitureKind, variant: number, source: SourceSheet): Promise<void>;
}

interface Copy {
  readonly src: ImageSource;
  readonly frames: Frames;
}

export function recolourSheets(): RecolourSheets {
  // shortcut: a copy is the whole sheet (≤ 512×512); crop to the `frames` prefix's rects if GPU memory gets tight.
  const copies = new Map<string, Copy>();
  const loading = new Map<string, Promise<void>>();
  const cache = new Map<string, Texture>();
  return {
    texture(key) {
      const cached = cache.get(key);
      if (cached !== undefined) return cached;
      const s = recolourSource(key);
      const copy = s === null ? undefined : copies.get(`${s.kind}/${String(s.variant)}`);
      const f = s === null ? undefined : copy?.frames[s.key];
      if (copy === undefined || f === undefined) return undefined;
      const { x, y, w, h } = f.frame;
      const t = new Texture({ source: copy.src, frame: new Rectangle(x, y, w, h), defaultAnchor: f.anchor });
      cache.set(key, t);
      return t;
    },
    load(kind, variant, source) {
      const id = `${kind}/${String(variant)}`;
      const r = recolourOf(kind, variant);
      if (r === undefined || copies.has(id)) return Promise.resolve();
      let p = loading.get(id);
      if (p === undefined) {
        p = fetch(source.url)
          .then(async (res) => {
            if (!res.ok) throw new Error(`recolour: ${String(res.status)}`);
            const png = retintPng(new Uint8Array(await res.arrayBuffer()), r.slots, r.colors);
            const bitmap = await createImageBitmap(new Blob([png], { type: "image/png" }));
            copies.set(id, { src: new ImageSource({ resource: bitmap, scaleMode: "nearest" }), frames: source.manifest.frames });
          })
          .finally(() => loading.delete(id));
        loading.set(id, p);
      }
      return p;
    },
  };
}
