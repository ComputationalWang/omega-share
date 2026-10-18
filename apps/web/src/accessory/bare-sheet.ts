// Pip's and Mo's bare heads (assets/accessories/bare.json, CC BY-SA 4.0, OME-1409): under the party hat, crown and
// headphones they take their own headwear off, as the overlays for them are drawn for these heads. A lazy chunk, fetched
// only once Pip or Mo wears one of those; its frames keep the avatar sheets' palette slots, so shirt tints apply.
import * as v from "valibot";
import json from "../../../../assets/accessories/bare.json";
import pngUrl from "../../../../assets/accessories/bare.png?url";
import { once } from "../atlas-sheet";
import { FramesSchema, type FrameRects } from "../walk/motion";
import { tintableSheets } from "../walk/tint-sheets";

const BareManifestSchema = v.object({ frames: FramesSchema, meta: v.object({ omega: v.object({ bare: v.object({ prefix: v.pipe(v.string(), v.minLength(1)) }) }) }) });

/** The bare frames keyed as the body frames they stand in for (`bare/K` as `K`), so a draw looks one up with the key it has. */
export function bareRects(json: unknown): FrameRects {
  const m = v.parse(BareManifestSchema, json);
  const { prefix } = m.meta.omega.bare;
  return Object.fromEntries(Object.entries(m.frames).flatMap(([k, f]) => (k.startsWith(prefix) ? [[k.slice(prefix.length), f]] : [])));
}

/** Load once; a failed load is forgotten so a later wearer can retry. */
export const loadBare = once(() => tintableSheets([pngUrl], [bareRects(json)]));
