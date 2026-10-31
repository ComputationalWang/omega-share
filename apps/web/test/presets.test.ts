import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import * as v from "valibot";
import { DEFAULT_ROOM_PRESET, FURNITURE, ROOM_PRESET_IDS, RoomLayoutSchema, layoutSeats } from "@omega/shared";
import bar from "../../../assets/presets/bar.json";
import cafe from "../../../assets/presets/cafe.json";
import cinema from "../../../assets/presets/cinema.json";
import classic from "../../../assets/presets/classic.json";
import dankDungeon from "../../../assets/presets/dank-dungeon.json";
import empty from "../../../assets/presets/empty.json";
import living from "../../../assets/presets/living.json";
import lounge from "../../../assets/presets/lounge.json";
import penthouse from "../../../assets/presets/penthouse.json";
import studio from "../../../assets/presets/studio.json";
import manifest from "../../../assets/presets/presets.json";
import { DEFAULT_PRESET, PRESETS, PRESET_THUMB } from "../src/presets";

const LAYOUTS: Readonly<Record<string, unknown>> = { classic, cinema, living, lounge, cafe, bar, empty, "dank-dungeon": dankDungeon, penthouse, studio };

describe("room presets (assets/presets/presets.json)", () => {
  test("the picker offers exactly the contract's preset ids, in the manifest's order", () => {
    expect(PRESETS.map((p): string => p.id)).toEqual(manifest.presets.map((p): string => p.id));
    expect(PRESETS.map((p): string => p.id).sort()).toEqual([...ROOM_PRESET_IDS].sort());
  });

  test("the default is classic, and the contract's default", () => {
    expect(DEFAULT_PRESET).toBe("classic");
    expect(DEFAULT_PRESET).toBe(DEFAULT_ROOM_PRESET);
    expect(PRESETS[0]?.id).toBe("classic");
  });

  test("each preset has a name and blurb to show, and the thumb size is fixed", () => {
    for (const p of PRESETS) {
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.blurb.length).toBeGreaterThan(0);
    }
    expect(PRESET_THUMB).toEqual({ w: 212, h: 176 });
  });

  test("every preset's layout file is a valid layout and its thumb exists", () => {
    for (const p of manifest.presets) {
      expect(v.safeParse(RoomLayoutSchema, LAYOUTS[p.id]).success).toBe(true);
      expect(existsSync(new URL(`../../../assets/presets/${p.thumb}`, import.meta.url))).toBe(true);
    }
  });
});

// OME-1630 (Movie night): the cinema preset is the Theatre, rows of seats on risers facing the big screen.
describe("the Theatre preset (id cinema)", () => {
  const layout = v.parse(RoomLayoutSchema, cinema);

  test("is offered as Theatre", () => {
    expect(PRESETS.find((p) => p.id === "cinema")?.name).toBe("Theatre");
  });

  test("seats only in theatre rows, every one facing the screen in the back corner", () => {
    const seatPieces = layout.furniture.filter((f) => FURNITURE[f.kind].seats);
    expect(seatPieces.length).toBeGreaterThan(0);
    expect(seatPieces.every((f) => f.kind === "theatrerow")).toBe(true);
    expect(layoutSeats(layout).every((s) => s.facing === "ne" || s.facing === "nw")).toBe(true);
    expect(layout.furniture.filter((f) => f.kind === "bigscreen" || f.kind === "tv")).toEqual([{ kind: "bigscreen", col: 0, row: 0, facing: "se" }]);
  });

  test("the rows step up toward the back of the room", () => {
    const risers = new Set(layout.furniture.filter((f) => f.kind === "theatrerow").map((f) => f.variant ?? 0));
    expect(risers.size).toBeGreaterThanOrEqual(2);
  });
});
