// Shirt tints (ADR 0053, art OME-1347): a tint is a PLTE swap of the avatar sheets. tints.json names, per avatar, the 3
// palette entries of its swatch ramp and 6 ramps to put there; tint 0 is the shipped look. Pure, no Pixi.
import * as v from "valibot";
import { TINT_COUNT } from "@omega/shared";

const HexSchema = v.pipe(v.string(), v.regex(/^#[0-9a-f]{6}$/));
const SlotSchema = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(255));
const RampSchema = v.object({ id: v.pipe(v.string(), v.regex(/^[a-z]+$/)), colors: v.tuple([HexSchema, HexSchema, HexSchema]) });
const TintsSchema = v.object({
  avatars: v.record(v.string(), v.object({ slots: v.tuple([SlotSchema, SlotSchema, SlotSchema]), tints: v.pipe(v.array(RampSchema), v.length(TINT_COUNT)) })),
});

/** The avatars' ids by avatar number (avatars.json's order, checked in walk-tint.test.ts). */
export const AVATAR_IDS: readonly string[] = ["juno", "pip", "mo", "kiki"];

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
