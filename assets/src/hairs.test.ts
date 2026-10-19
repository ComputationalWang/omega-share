// Hair colours (OME-1436): a hair swap changes only hair pixels (bare heads too), its PLTE slots are disjoint from the tint
// slots so every hair × tint pair composes, colours stay apart, and hairs.json's slots match the shipped sheets.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ACCESSORIES, BARE } from "./accessories";
import { AVATARS, composeFrame } from "./avatars";
import { HAIRS, assertHairOnly, hairRamp, hairRemap, hairSlots, hairSpread, lookRemap } from "./hairs";
import { CHRISTMAS } from "./christmas";
import { EASTER } from "./easter";
import { HALLOWEEN } from "./halloween";
import { RAMPS } from "./palette";
import { SINTERKLAAS } from "./sinterklaas";
import { render } from "./sprite";
import { applyRemap, tintRemap } from "./tints";
import { VALENTINES } from "./valentines";

const ROOT = join(import.meta.dir, "..");
const table = JSON.parse(readFileSync(join(ROOT, "avatars", "hairs.json"), "utf8")) as {
  sheets: string[];
  overlays: string[];
  avatars: Record<string, { slots: number[]; hairs: { colors: string[] }[] }>;
};

/** PLTE entries of a PNG as #rrggbb. */
function plte(file: string): string[] {
  const b = readFileSync(join(ROOT, "avatars", file));
  for (let o = 8; o < b.length; ) {
    const len = b.readUInt32BE(o);
    if (b.toString("latin1", o + 4, o + 8) === "PLTE") {
      const out: string[] = [];
      for (let i = 0; i < len; i += 3) out.push("#" + b.subarray(o + 8 + i, o + 11 + i).toString("hex"));
      return out;
    }
    o += 12 + len;
  }
  throw new Error(`${file}: no PLTE`);
}

// Hat overlays (accessories, holiday hats) redraw the hair around the hat in the avatar's hair slots, so the client swaps them
// too. That is only safe if no hat material uses a hair colour.
test("no hat role shares a colour with any avatar's hair ramp", () => {
  const hair = new Set<string>(AVATARS.flatMap((a) => RAMPS[a.roles["H"]?.ramp ?? "outline"]));
  const hats = [...ACCESSORIES.map((x) => [x.id, x.hat] as const), ...[HALLOWEEN, SINTERKLAAS, CHRISTMAS, VALENTINES, EASTER].map((t) => [t.id, t.hat] as const)];
  const clashes = hats.flatMap(([id, hat]) => Object.entries(hat.roles).flatMap(([role, spec]) => (RAMPS[spec.ramp].some((h) => hair.has(h)) ? [`${id}:${role}:${spec.ramp}`] : [])));
  expect(clashes).toEqual([]);
});

describe.each(AVATARS.map((a) => [a.id, a] as const))("%s", (_id, a) => {
  test("hair colours sit only on hair roles and never on a tint slot", () => {
    assertHairOnly(a);
  });
  test("hair colours are ΔE ≥ 20 apart (also under deutan and protan), from skin and from every tint", () => {
    const s = hairSpread(a);
    expect(s.hairs).toBeGreaterThanOrEqual(20);
    expect(s.cvd).toBeGreaterThanOrEqual(20);
    expect(s.skin).toBeGreaterThanOrEqual(20);
    expect(s.tint).toBeGreaterThanOrEqual(20);
  });
  const looks = [["front", composeFrame(a, "idle", "se", false), a.roles] as const, ["back", composeFrame(a, "idle", "nw", false), a.roles] as const];
  const bare = BARE.get(a.id);
  const all = bare ? [...looks, ["bare", composeFrame(bare, "idle", "se", false), bare.roles] as const] : looks;
  test.each(all.map(([n, g, r]) => [n, g, r] as const))("a hair swap changes only hair pixels (%s)", (_n, g, roles) => {
    const base = render(g, roles);
    for (let n = 1; n < 6; n++) {
      const out = applyRemap(base, hairRemap(a, n));
      const changed = [...out].flatMap((v, i) => (v === base[i] ? [] : [g[Math.floor(i / 32)]?.[i % 32] ?? "?"]));
      expect(changed.length).toBeGreaterThan(0);
      expect(changed.filter((ch) => !"Hqb".includes(ch))).toEqual([]);
    }
  });
  test("every hair × tint pair = the hair swap on hair pixels + the tint swap on shirt pixels", () => {
    const base = render(composeFrame(a, "idle", "se", false), a.roles);
    for (let h = 0; h < 6; h++)
      for (let t = 0; t < 6; t++) {
        const both = applyRemap(base, lookRemap(a, h, t));
        // In either order: tint then hair, and hair then tint, give the same pixels.
        expect(applyRemap(applyRemap(base, tintRemap(a, t)), hairRemap(a, h))).toEqual(both);
        expect(applyRemap(applyRemap(base, hairRemap(a, h)), tintRemap(a, t))).toEqual(both);
      }
  });
  test("hairs.json slots hold the hair-0 colours in every shipped sheet, bare.png and hat overlays included", () => {
    const row = table.avatars[a.id];
    expect(row?.hairs.length).toBe(6);
    expect(row?.slots).toEqual(hairSlots(a));
    expect(table.sheets).toContain("../accessories/bare.png");
    for (const f of [...table.sheets, ...table.overlays]) expect(row?.slots.map((i) => plte(f)[i])).toEqual([...hairRamp(HAIRS[a.id]?.[0] ?? "hairDark")]);
  });
});
