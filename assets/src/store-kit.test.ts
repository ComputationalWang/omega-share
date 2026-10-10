import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// OME-843: the Web Store kit's files at the exact sizes the stores ask for, each under 1 MB. PNG width/height from IHDR.
const STORE = join(import.meta.dir, "..", "store");
const KIT: readonly [string, number, number][] = [
  ["promo-440x280.png", 440, 280],
  ["screenshot-1-room.png", 1280, 800],
  ["screenshot-2-share.png", 1280, 800],
  ["screenshot-3-chat.png", 1280, 800],
  ["screenshot-4-queue.png", 1280, 800],
  ["marquee-1400x560.png", 1400, 560],
];

describe("Web Store kit (OME-843)", () => {
  for (const [file, w, h] of KIT) {
    test(`${file} is ${String(w)}×${String(h)} and < 1 MB`, () => {
      const png = readFileSync(join(STORE, file));
      expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([w, h]);
      expect(png.length).toBeLessThan(1024 * 1024);
    });
  }
});
