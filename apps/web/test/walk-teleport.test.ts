import { describe, expect, test } from "bun:test";
import type { MemberId } from "@omega/shared";
import { cellCenter, type Point } from "../src/layout";
import { standDepth } from "../src/furniture";
import { findPath, walkGrid } from "../src/walk/path";
import { createWalks, emptyPose, type WalkTarget } from "../src/walk/walks";

// OME-1548: a `walked` with `teleport` snaps the avatar to the other pad, and the arrival sparkles at both.

const id = (s: string): MemberId => s;
const stand = (who: string, col: number, row: number, teleport = false): WalkTarget => {
  const at = cellCenter(col, row);
  return { id: id(who), at, z: standDepth(at), seatFacing: null, ...(teleport ? { teleport } : {}) };
};

function setup(reduced = false) {
  const hops: { from: Point; to: Point }[] = [];
  const walks = createWalks({
    reducedMotion: () => reduced,
    smooth: () => false,
    route: findPath,
    onTeleport: (from, to) => hops.push({ from, to }),
  });
  walks.setGrid(walkGrid({ furniture: [] }));
  const pose = emptyPose();
  return { walks, hops, at: (who: string, now: number) => (walks.sample(id(who), now, pose) ? { ...pose } : null) };
}

describe("teleport", () => {
  test("the avatar is on the other pad at once, not walking, and both pads sparkle", () => {
    const { walks, hops, at } = setup();
    walks.place([stand("a", 3, 3)], 0);
    walks.place([stand("a", 6, 6, true)], 1000);
    expect(at("a", 1000)).toMatchObject({ ...cellCenter(6, 6), walking: false });
    expect(walks.walking(1000)).toBe(false);
    expect(hops).toEqual([{ from: cellCenter(3, 3), to: cellCenter(6, 6) }]);
  });
  test("an ordinary walk walks and does not sparkle", () => {
    const { walks, hops, at } = setup();
    walks.place([stand("a", 3, 3)], 0);
    walks.place([stand("a", 6, 6)], 1000);
    expect(at("a", 1000)?.walking).toBe(true);
    expect(hops).toEqual([]);
  });
  test("under reduced motion the snap still happens, with no sparkle", () => {
    const { walks, hops, at } = setup(true);
    walks.place([stand("a", 3, 3)], 0);
    walks.place([stand("a", 6, 6, true)], 1000);
    expect(at("a", 1000)).toMatchObject({ ...cellCenter(6, 6), walking: false });
    expect(hops).toEqual([]);
  });
  test("placing the same teleport target again sparkles nothing more", () => {
    const { walks, hops } = setup();
    walks.place([stand("a", 3, 3)], 0);
    walks.place([stand("a", 6, 6, true)], 1000);
    walks.place([stand("a", 6, 6, true)], 1100);
    expect(hops).toHaveLength(1);
  });
});
