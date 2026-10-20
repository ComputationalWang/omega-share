import { describe, expect, test } from "bun:test";
import type { MemberId } from "@omega/shared";
import { cellCenter, type Point } from "../src/layout";
import { standDepth } from "../src/furniture";
import { findPath, walkGrid } from "../src/walk/path";
import { createWalks, emptyPose, type WalkTarget } from "../src/walk/walks";

// OME-1558: someone the server placed in front of a door at join (`join.via`) walked in through that door: they stand
// there at once, no walk from the front corner, and the door's spot sparkles (not under reduced motion).

const id = (s: string): MemberId => s;
const stand = (who: string, col: number, row: number, door = false): WalkTarget => {
  const at = cellCenter(col, row);
  return { id: id(who), at, z: standDepth(at), seatFacing: null, ...(door ? { door } : {}) };
};

function setup(reduced = false) {
  const arrivals: Point[] = [];
  let corner = 0;
  const walks = createWalks({
    reducedMotion: () => reduced,
    smooth: () => false,
    route: findPath,
    onDoor: () => corner++,
    onDoorway: (at) => arrivals.push(at),
  });
  walks.setGrid(walkGrid({ furniture: [] }));
  const pose = emptyPose();
  return { walks, arrivals, corner: () => corner, at: (who: string, now: number) => (walks.sample(id(who), now, pose) ? { ...pose } : null) };
}

describe("arriving through a door", () => {
  test("someone new in front of a door stands there at once and sparkles there, not at the corner", () => {
    const { walks, arrivals, corner, at } = setup();
    walks.place([stand("x", 5, 5)], 0);
    walks.place([stand("x", 5, 5), stand("a", 1, 3, true)], 1000);
    expect(at("a", 1000)).toMatchObject({ ...cellCenter(1, 3), walking: false });
    expect(walks.walking(1000)).toBe(false);
    expect(arrivals).toEqual([cellCenter(1, 3)]);
    expect(corner()).toBe(0);
  });
  test("my own arrival in my first snapshot sparkles too", () => {
    const { walks, arrivals } = setup();
    walks.place([stand("x", 5, 5), stand("me", 1, 3, true)], 0);
    expect(arrivals).toEqual([cellCenter(1, 3)]);
  });
  test("reduced motion: there at once, no sparkle", () => {
    const { walks, arrivals, at } = setup(true);
    walks.place([stand("x", 5, 5)], 0);
    walks.place([stand("x", 5, 5), stand("a", 1, 3, true)], 1000);
    expect(at("a", 1000)).toMatchObject({ ...cellCenter(1, 3), walking: false });
    expect(arrivals).toEqual([]);
  });
  test("someone already in the room who walks to the door walks, without a sparkle", () => {
    const { walks, arrivals, at } = setup();
    walks.place([stand("a", 5, 5)], 0);
    walks.place([stand("a", 1, 3, true)], 1000);
    expect(at("a", 1000)?.walking).toBe(true);
    expect(arrivals).toEqual([]);
  });
  test("a newcomer without the door flag still walks in from the corner", () => {
    const { walks, arrivals, corner, at } = setup();
    walks.place([stand("x", 5, 5)], 0);
    walks.place([stand("x", 5, 5), stand("a", 1, 3)], 1000);
    expect(at("a", 1000)?.walking).toBe(true);
    expect(corner()).toBe(1);
    expect(arrivals).toEqual([]);
  });
});
