// Set (n): the shipped room presets are valid layouts (the same strict schema an owner's `layout-set` meets), and their
// thumbnails exist, have the manifest's size and stay inside the 40 KB budget (OME-906).
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as v from "valibot";
import { RoomLayoutInputSchema, SEAT_COUNT, layoutSeats } from "@omega/shared";
import { PRESETS } from "./presets";

const DIR = join(import.meta.dir, "..", "presets");
const Manifest = v.strictObject({
  version: v.literal(1),
  license: v.literal("CC-BY-SA-4.0"),
  default: v.string(),
  thumb: v.strictObject({ w: v.number(), h: v.number(), scale: v.number() }),
  presets: v.array(v.strictObject({ id: v.pipe(v.string(), v.regex(/^[a-z]{1,12}$/)), name: v.string(), blurb: v.pipe(v.string(), v.maxLength(60)), layout: v.string(), thumb: v.string() })),
});
const manifest = v.parse(Manifest, JSON.parse(readFileSync(join(DIR, "presets.json"), "utf8")));
const pngSize = (buf: Buffer): { w: number; h: number } => ({ w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) });

describe("room presets", () => {
  test("five or six, unique ids, the default among them", () => {
    expect(manifest.presets.length).toBeGreaterThanOrEqual(5);
    expect(manifest.presets.length).toBeLessThanOrEqual(6);
    const ids = manifest.presets.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(manifest.default);
  });

  for (const entry of manifest.presets) {
    test(`${entry.id}: the layout file passes RoomLayoutInputSchema and matches presets.ts`, () => {
      const layout: unknown = JSON.parse(readFileSync(join(DIR, entry.layout), "utf8"));
      const parsed = v.safeParse(RoomLayoutInputSchema, layout);
      expect(parsed.issues?.map((i) => i.message) ?? []).toEqual([]);
      if (!parsed.success) return;
      expect(layoutSeats(parsed.output)).toHaveLength(SEAT_COUNT);
      // Every seat looks toward the TV corner.
      expect(layoutSeats(parsed.output).every((s) => s.facing === "ne" || s.facing === "nw")).toBe(true);
      expect(layout).toEqual(PRESETS.find((p) => p.id === entry.id)?.layout);
    });
  }

  test("thumbnails: one per preset at the manifest size, ≤ 40 KB together, no strays", () => {
    let bytes = 0;
    for (const entry of manifest.presets) {
      const buf = readFileSync(join(DIR, entry.thumb));
      expect(pngSize(buf)).toEqual({ w: manifest.thumb.w, h: manifest.thumb.h });
      bytes += buf.length;
    }
    expect(bytes).toBeLessThanOrEqual(40 * 1024);
    const files = readdirSync(join(DIR, "thumbs")).sort();
    expect(files).toEqual(manifest.presets.map((p) => p.thumb.replace("thumbs/", "")).sort());
  });
});
