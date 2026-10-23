// Shirt tints (ADR 0053, art OME-1347): a tint is a PLTE swap of the avatar sheets. tints.json names, per avatar, the 3
// palette entries of its swatch ramp and 6 ramps to put there; tint 0 is the shipped look. Pure, no Pixi.
import * as v from "valibot";
import { HAIR_COUNT, TINT_COUNT } from "@omega/shared";
import { avatars as hairAvatars } from "../../../../assets/avatars/hairs.json";
import { AVATAR_IDS } from "./avatar-ids";

const HexSchema = v.pipe(v.string(), v.regex(/^#[0-9a-f]{6}$/));
const SlotSchema = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(255));
const RampSchema = v.object({ id: v.pipe(v.string(), v.regex(/^[a-z]+$/)), colors: v.tuple([HexSchema, HexSchema, HexSchema]) });
const TintsSchema = v.object({
  avatars: v.record(v.string(), v.object({ slots: v.tuple([SlotSchema, SlotSchema, SlotSchema]), tints: v.pipe(v.array(RampSchema), v.length(TINT_COUNT)) })),
});

export { AVATAR_IDS };

export type TintRamp = v.InferOutput<typeof RampSchema>;
export type AvatarTints = v.InferOutput<typeof TintsSchema>["avatars"][string];

/** Each avatar's tints, in avatar order (`ids`, avatars.json's). Throws if one is missing. */
export function parseTints(json: unknown, ids: readonly string[]): readonly AvatarTints[] {
  const { avatars } = v.parse(TintsSchema, json);
  return ids.map((id) => {
    const a = avatars[id];
    if (a === undefined) throw new Error(`tints: no avatar ${id}`);
    return a;
  });
}

/** A member's shirt colour for their bubble edge and name tag (OME-1375). */
export function tintAccent(tints: readonly AvatarTints[], avatar: number, tint: number): string | null {
  return tints[avatar]?.tints[tint]?.colors[1] ?? null;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A copy of a paletted PNG with PLTE entries `slots[i]` set to `colors[i]` and the chunk's CRC redone. */
export function retintPng(png: Uint8Array, slots: readonly number[], colors: readonly string[]): Uint8Array<ArrayBuffer> {
  if (png.length < 8 || SIGNATURE.some((b, i) => png[i] !== b)) throw new Error("retint: not a PNG");
  const out = new Uint8Array(png);
  const dv = new DataView(out.buffer);
  for (let i = 8; i + 12 <= out.length; ) {
    const len = dv.getUint32(i);
    if (dv.getUint32(i + 4) === 0x504c5445 /* PLTE */) {
      slots.forEach((slot, n) => {
        const hex = Number.parseInt((colors[n] ?? "").slice(1), 16);
        if ((slot + 1) * 3 > len || Number.isNaN(hex)) throw new Error("retint: slot or colour out of range");
        out.set([hex >> 16, (hex >> 8) & 0xff, hex & 0xff], i + 8 + slot * 3);
      });
      dv.setUint32(i + 8 + len, crc32(out.subarray(i + 4, i + 8 + len)));
      return out;
    }
    i += 12 + len;
  }
  throw new Error("retint: no PLTE");
}

// Hair colours (OME-1438, art OME-1436): hairs.json is tints.json's shape on the hair slots (disjoint from the tint
// ones). The art's own names for the shipped ramps (`hairDark`, …) are the swatch's "Dark", …
const HairsSchema = v.object({
  avatars: v.record(
    v.string(),
    v.object({
      slots: v.tuple([SlotSchema, SlotSchema, SlotSchema]),
      hairs: v.pipe(v.array(v.object({ id: v.pipe(v.string(), v.regex(/^[a-zA-Z]+$/), v.transform((id) => id.replace(/^hair(?=[A-Z])/, "").toLowerCase())), colors: v.tuple([HexSchema, HexSchema, HexSchema]) })), v.length(HAIR_COUNT)),
    }),
  ),
});

export type AvatarHairs = v.InferOutput<typeof HairsSchema>["avatars"][string];

/** Each avatar's hair colours, in avatar order (`ids`). Throws if one is missing. */
export function parseHairs(json: unknown, ids: readonly string[]): readonly AvatarHairs[] {
  const { avatars } = v.parse(HairsSchema, json);
  return ids.map((id) => {
    const a = avatars[id];
    if (a === undefined) throw new Error(`hairs: no avatar ${id}`);
    return a;
  });
}

/** The shipped hair colours, parsed once here so the landing, the room and the sheets share one copy (one chunk). */
export const AVATAR_HAIRS: readonly AvatarHairs[] = parseHairs({ avatars: hairAvatars }, AVATAR_IDS);

/** The PLTE patch that draws `avatar` in shirt `tint` and hair `hair` (0s, or numbers it doesn't have: none of that part). */
export function lookPatch(tints: readonly AvatarTints[], hairs: readonly AvatarHairs[], avatar: number, tint: number, hair: number): { slots: number[]; colors: string[] } {
  const t = tint === 0 ? undefined : tints[avatar];
  const h = hair === 0 ? undefined : hairs[avatar];
  const tc = t?.tints[tint]?.colors;
  const hc = h?.hairs[hair]?.colors;
  return { slots: [...(tc === undefined ? [] : (t?.slots ?? [])), ...(hc === undefined ? [] : (h?.slots ?? []))], colors: [...(tc ?? []), ...(hc ?? [])] };
}
