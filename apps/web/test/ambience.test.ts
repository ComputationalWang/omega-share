// Mood ambience (OME-1689): the room mood's particles on the theme effect's pool. Night snows, Warm floats dust; a
// holiday theme's effect owns the pool, and reduced motion turns ambience off.
import { describe, expect, test } from "bun:test";
import { ROOM_MOODS, type RoomMood } from "@omega/shared";
import { ambienceFor, type Ambience } from "../src/theme/ambience";
import { MAX_EFFECT_SPRITES } from "../src/theme/effect";
import { THEME_IDS } from "../src/theme/periods";

describe("ambienceFor", () => {
  test("night snows, warm floats dust motes, none and cool have none", () => {
    const kinds: Record<RoomMood, Ambience["kind"] | null> = { none: null, warm: "dust", cool: null, night: "snow" };
    for (const m of ROOM_MOODS) expect(ambienceFor(m, null, true)?.kind ?? null, m).toBe(kinds[m]);
  });

  test("a running holiday theme keeps the pool: ambience takes no sprites next to it", () => {
    for (const id of THEME_IDS) for (const m of ROOM_MOODS) expect(ambienceFor(m, id, true), `${id}/${m}`).toBeNull();
  });

  test("reduced motion (or the Basic tier) turns it off", () => {
    for (const m of ROOM_MOODS) expect(ambienceFor(m, null, false), m).toBeNull();
  });

  test("it stays inside the effect pool, with one or two tiny frames inside its art", () => {
    for (const m of ["night", "warm"] as const) {
      const a = ambienceFor(m, null, true);
      expect(a, m).not.toBeNull();
      if (a === null) continue;
      expect(a.max).toBeGreaterThan(0);
      expect(a.max).toBeLessThanOrEqual(MAX_EFFECT_SPRITES);
      expect(a.frames.length).toBeGreaterThanOrEqual(1);
      expect(a.frames.length).toBeLessThanOrEqual(2);
      for (const f of a.frames) {
        expect(f.w).toBeLessThanOrEqual(4);
        expect(f.h).toBeLessThanOrEqual(4);
        expect(f.sx + f.w).toBeLessThanOrEqual(a.w);
        expect(f.sy + f.h).toBeLessThanOrEqual(a.h);
      }
    }
  });
});
