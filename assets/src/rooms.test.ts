import { describe, expect, test } from "bun:test";
import { buildRoomsScenes, vignette } from "./rooms";

// OME-841: "Room not found" gets its own lazy scene, so the W2 page doesn't borrow `closed` (taken down) or `removed`.
describe("not-found scene (OME-841)", () => {
  const nf = buildRoomsScenes().find((f) => f.key === "scene/not-found");

  test("ships with the other room scenes at the family's 72×64", () => {
    expect(nf).toBeDefined();
    expect(nf?.w).toBe(72);
    expect(nf?.h).toBe(64);
  });

  test("differs clearly from closed, invite and removed (over a fifth of its pixels)", () => {
    const img = nf?.img ?? new Uint8Array();
    for (const kind of ["closed", "invite", "removed"] as const) {
      const other = vignette(kind).img;
      let diff = 0;
      for (let i = 0; i < img.length; i++) if (img[i] !== other[i]) diff++;
      expect(diff / img.length).toBeGreaterThan(0.2);
    }
  });

  test("keeps the family's plum outline on all four edges", () => {
    const f = vignette("not-found");
    const o = f.img[0];
    for (let x = 0; x < f.w; x++) { expect(f.img[x]).toBe(o); expect(f.img[(f.h - 1) * f.w + x]).toBe(o); }
    for (let y = 0; y < f.h; y++) { expect(f.img[y * f.w]).toBe(o); expect(f.img[y * f.w + f.w - 1]).toBe(o); }
  });
});
