// The head accessories sheet (OME-1388) and who wears which hat (OME-1391): the sheet parses at the boundary with a hat for
// every avatar body frame, and a member's own accessory wins over the holiday theme's hat, one hat at a time.
import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import { ACCESSORY_COUNT } from "@omega/shared";
import { ACCESSORY_IDS, wearsBare, wornHat } from "../src/accessory/hat";
import { AVATAR_IDS } from "../src/walk/tint";
import { AccessoryManifestSchema } from "../src/accessory/accessories-sheet";
import { bareRects } from "../src/accessory/bare-sheet";

const asset = (p: string): URL => new URL(`../../../assets/${p}`, import.meta.url);
const sheet = v.parse(AccessoryManifestSchema, await Bun.file(asset("accessories/accessories.json")).json());

const bare: unknown = await Bun.file(asset("accessories/bare.json")).json();
const bodyFrames: string[] = [];
for (const f of ["avatars", "motion", "expressions"]) {
  const { frames } = v.parse(v.object({ frames: v.record(v.string(), v.unknown()) }), await Bun.file(asset(`avatars/${f}.json`)).json());
  for (const k of Object.keys(frames)) if (!k.startsWith("emote/")) bodyFrames.push(k);
}

describe("accessories sheet", () => {
  test("accessory 1..8 are the sheet's eight, in the wire order (0 is none; 5..8 OME-1532)", () => {
    expect(ACCESSORY_IDS).toEqual(["partyhat", "crown", "headphones", "beanie", "cap", "flower", "bow", "halo"]);
    expect(ACCESSORY_COUNT - 1).toBe(ACCESSORY_IDS.length);
    expect(Object.keys(sheet.meta.omega.accessories).sort()).toEqual([...ACCESSORY_IDS].sort());
  });

  test("every avatar body frame has each accessory's hat", () => {
    for (const id of ACCESSORY_IDS) {
      const { prefix } = sheet.meta.omega.accessories[id];
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

// OME-1404 (art OME-1409): Pip and Mo take their own headwear off under the party hat, crown and headphones.
describe("bare heads under an accessory", () => {
  const meta = v.parse(v.object({ meta: v.object({ omega: v.object({ bare: v.object({ avatars: v.array(v.string()), accessories: v.array(v.string()) }) }) }) }), bare).meta.omega.bare;
  test("who goes bare is the sheets' rule: an avatar in bare.avatars wearing an accessory marked bare", () => {
    for (let avatar = 0; avatar < AVATAR_IDS.length; avatar++)
      for (let accessory = 0; accessory <= ACCESSORY_IDS.length; accessory++) {
        const id = ACCESSORY_IDS[accessory - 1];
        const want = id !== undefined && sheet.meta.omega.accessories[id].bare && meta.avatars.includes(AVATAR_IDS[avatar] ?? "") && meta.accessories.includes(id);
        expect([avatar, accessory, wearsBare(avatar, accessory)]).toEqual([avatar, accessory, want]);
      }
    expect(wearsBare(1, 2)).toBe(true);
    expect(wearsBare(2, 3)).toBe(true);
    expect(wearsBare(1, 4)).toBe(false);
    expect(wearsBare(0, 2)).toBe(false);
    // OME-1532: the cap and the bow too; not the flower or the halo.
    expect([5, 6, 7, 8].map((a) => wearsBare(1, a))).toEqual([true, false, true, false]);
  });
  test("the bare frames are keyed as the body frames they stand in for: every one of Pip's and Mo's, no one else's", () => {
    const rects = bareRects(bare);
    const want = bodyFrames.filter((k) => /(^|\/)(pip|mo)\//.test(k)).sort();
    expect(Object.keys(rects).sort()).toEqual(want);
  });
  test("a malformed bare sheet is refused", () => {
    expect(() => bareRects({ frames: {}, meta: { omega: {} } })).toThrow();
  });
});
