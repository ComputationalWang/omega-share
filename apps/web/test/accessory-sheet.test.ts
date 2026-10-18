// The head accessories sheet (OME-1388) and who wears which hat (OME-1391): the sheet parses at the boundary with a hat for
// every avatar body frame, and a member's own accessory wins over the holiday theme's hat, one hat at a time.
import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import { ACCESSORY_COUNT } from "@omega/shared";
import { ACCESSORY_IDS, wornHat } from "../src/accessory/hat";
import { AccessoryManifestSchema } from "../src/accessory/sheet";

const asset = (p: string): URL => new URL(`../../../assets/${p}`, import.meta.url);
const sheet = v.parse(AccessoryManifestSchema, await Bun.file(asset("accessories/accessories.json")).json());

const bodyFrames: string[] = [];
for (const f of ["avatars", "motion", "expressions"]) {
  const { frames } = v.parse(v.object({ frames: v.record(v.string(), v.unknown()) }), await Bun.file(asset(`avatars/${f}.json`)).json());
  for (const k of Object.keys(frames)) if (!k.startsWith("emote/")) bodyFrames.push(k);
}

describe("accessories sheet", () => {
  test("accessory 1..4 are the sheet's four, in the wire order (0 is none)", () => {
    expect(ACCESSORY_IDS).toEqual(["partyhat", "crown", "headphones", "beanie"]);
    expect(ACCESSORY_IDS.length).toBe(ACCESSORY_COUNT - 1);
    expect(Object.keys(sheet.meta.omega.accessories).sort()).toEqual([...ACCESSORY_IDS].sort());
  });

  test("every avatar body frame has each accessory's hat", () => {
    for (const id of ACCESSORY_IDS) {
      const prefix = sheet.meta.omega.accessories[id]?.prefix ?? "missing/";
      expect(bodyFrames.filter((k) => sheet.frames[prefix + k] === undefined)).toEqual([]);
    }
  });

  test("an unknown or malformed manifest is refused", () => {
    expect(v.safeParse(AccessoryManifestSchema, { frames: {}, meta: { omega: {} } }).success).toBe(false);
  });
});

describe("wornHat: the member's own accessory over the theme hat", () => {
  const theme = { hat: (f: string) => `theme:${f}` };
  const accessories = { hat: (a: number, f: string) => (f === "bare" ? undefined : `acc${String(a)}:${f}`) };
  test("no accessory: the theme's hat, or none without a theme", () => {
    expect(wornHat(0, "k", accessories, theme)).toBe("theme:k");
    expect(wornHat(0, "k", accessories, null)).toBeUndefined();
  });
  test("an accessory wins over the theme's hat", () => {
    expect(wornHat(2, "k", accessories, theme)).toBe("acc2:k");
    expect(wornHat(3, "k", accessories, null)).toBe("acc3:k");
  });
  test("until the sheet is in, or for a frame it has no hat for, the theme's hat stands in", () => {
    expect(wornHat(2, "k", null, theme)).toBe("theme:k");
    expect(wornHat(2, "bare", accessories, theme)).toBe("theme:bare");
    expect(wornHat<string>(2, "k", null, null)).toBeUndefined();
  });
});
