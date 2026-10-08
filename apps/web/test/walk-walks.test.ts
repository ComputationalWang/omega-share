import { describe, expect, test } from "bun:test";
import { DEFAULT_LAYOUT, type MemberId } from "@omega/shared";
import { cellCenter } from "../src/layout";
import { standDepth } from "../src/furniture";
import { DOOR, centerOf, findPath, walkGrid } from "../src/walk/path";
import { createWalks, emptyPose, type Dir, type WalkTarget } from "../src/walk/walks";

// OME-408: the server stays seat-authoritative; each client animates the walk to the new spot locally, time-based.
// ADR 0010 walk contract: 150 ms per frame, 4 frames per tile → 600 ms per tile.

const TILE_MS = 600;
const id = (s: string): MemberId => s as MemberId;
const grid = walkGrid(DEFAULT_LAYOUT);

const sitAt = (who: string, col: number, row: number, facing: Dir = col < row ? "ne" : "nw", z = 999): WalkTarget => ({ id: id(who), at: cellCenter(col, row), z, seatFacing: facing });
const standAt = (who: string, col: number, row: number): WalkTarget => {
  const at = cellCenter(col, row);
  return { id: id(who), at, z: standDepth(at), seatFacing: null };
};

function setup(opts: { reduced?: boolean } = {}) {
  let routes = 0;
  const walks = createWalks({
    reducedMotion: () => opts.reduced ?? false,
    route: (g, from, to) => {
      routes++;
      return findPath(g, from, to);
    },
  });
  walks.setGrid(grid);
  const pose = emptyPose();
  const sample = (who: string, now: number) => (walks.sample(id(who), now, pose) ? { ...pose } : null);
  return { walks, sample, routes: () => routes };
}

describe("walks", () => {
  test("the first placement (my snapshot) puts everyone in place: a late joiner sees seated avatars, no walk", () => {
    const { walks, sample } = setup();
    walks.place([sitAt("a", 1, 5), standAt("b", 4, 9)], 1000);
    expect(sample("a", 1000)).toMatchObject({ ...cellCenter(1, 5), z: 999, walking: false, sitting: true, dir: "ne" });
    expect(sample("b", 1000)).toMatchObject({ ...cellCenter(4, 9), walking: false, sitting: false });
    expect(walks.walking(1000)).toBe(false);
  });

  test("someone who joins later walks in from the door, then stands at their spot", () => {
    const { walks, sample } = setup();
    walks.place([sitAt("a", 1, 5)], 0);
    walks.place([sitAt("a", 1, 5), standAt("b", 6, 9)], 1000);
    // Door (9,9) → (6,9): three tiles towards -col, i.e. nw.
    expect(sample("b", 1000)).toMatchObject({ ...centerOf(DOOR), walking: true, dir: "nw", sitting: false });
    expect(walks.walking(1000)).toBe(true);
    const half = sample("b", 1000 + TILE_MS / 2);
    const door = centerOf(DOOR);
    const next = cellCenter(8, 9);
    expect(half).toMatchObject({ x: (door.x + next.x) / 2, y: (door.y + next.y) / 2, walking: true });
    expect(half?.z).toBe(standDepth({ x: (door.x + next.x) / 2, y: (door.y + next.y) / 2 }));
    expect(sample("b", 1000 + 3 * TILE_MS)).toMatchObject({ ...cellCenter(6, 9), walking: false, sitting: false });
    expect(walks.walking(1000 + 3 * TILE_MS)).toBe(false);
  });

  test("a seat change walks from the previous seat to the new one, then sits facing the seat's way", () => {
    const { walks, sample } = setup();
    walks.place([sitAt("a", 4, 6, "ne", 111)], 0);
    walks.place([sitAt("a", 4, 2, "nw", 222)], 5000);
    const start = sample("a", 5000);
    expect(start).toMatchObject({ ...cellCenter(4, 6), walking: true, sitting: false });
    // Done after (path length - 1) tiles, never sooner.
    const path = findPath(grid, 46, 42) ?? [];
    const end = 5000 + (path.length - 1) * TILE_MS;
    expect(sample("a", end - 1)?.walking).toBe(true);
    expect(sample("a", end)).toMatchObject({ ...cellCenter(4, 2), z: 222, walking: false, sitting: true, dir: "nw" });
  });

  test("the walk frame steps every 150 ms and loops every tile; direction follows each step's axis", () => {
    const { walks, sample } = setup();
    walks.place([standAt("a", 5, 9)], 0);
    walks.place([standAt("a", 5, 6)], 0); // three tiles towards -row: ne
    expect([0, 149, 150, 300, 450, 600].map((t) => sample("a", t)?.step)).toEqual([0, 0, 1, 2, 3, 0]);
    expect(sample("a", 100)?.dir).toBe("ne");
    walks.place([standAt("a", 8, 6)], 1800); // from (5,6): +col is se
    expect(sample("a", 1800 + 10)?.dir).toBe("se");
  });

  test("standing at rest faces the TV: ne left of the aisle (col < row), nw right of it", () => {
    const { walks, sample } = setup();
    walks.place([standAt("a", 4, 9), standAt("b", 9, 4)], 0);
    expect(sample("a", 0)?.dir).toBe("ne");
    expect(sample("b", 0)?.dir).toBe("nw");
  });

  test("a new target mid-walk turns from where the avatar is, without a jump", () => {
    const { walks, sample } = setup();
    walks.place([standAt("a", 9, 5)], 0);
    walks.place([standAt("a", 5, 5)], 0);
    const before = sample("a", 900);
    walks.place([standAt("a", 9, 5)], 900);
    expect(sample("a", 900)).toMatchObject({ x: before?.x, y: before?.y, walking: true, dir: "se" });
    // 1.5 tiles back the way it came.
    expect(sample("a", 900 + 1.5 * TILE_MS)).toMatchObject({ ...cellCenter(9, 5), walking: false });
  });

  test("pathfinding runs once per target change, never per frame", () => {
    const { walks, sample, routes } = setup();
    walks.place([standAt("a", 9, 5)], 0);
    walks.place([standAt("a", 5, 5), standAt("b", 4, 9)], 0);
    const after = routes();
    expect(after).toBe(2);
    for (let t = 0; t < 5000; t += 16) {
      sample("a", t);
      sample("b", t);
      walks.walking(t);
    }
    walks.place([standAt("a", 5, 5), standAt("b", 4, 9)], 5000);
    expect(routes()).toBe(after);
  });

  test("prefers-reduced-motion skips straight to the spot", () => {
    const { walks, sample, routes } = setup({ reduced: true });
    walks.place([standAt("a", 9, 5)], 0);
    walks.place([sitAt("a", 4, 6), standAt("b", 4, 9)], 10);
    expect(sample("a", 10)).toMatchObject({ ...cellCenter(4, 6), walking: false, sitting: true });
    expect(sample("b", 10)).toMatchObject({ ...cellCenter(4, 9), walking: false });
    expect(walks.walking(10)).toBe(false);
    expect(routes()).toBe(0);
  });

  test("an unreachable spot is a jump, not a stuck walk", () => {
    const { walks, sample } = setup();
    const boxed = walkGrid(DEFAULT_LAYOUT);
    for (const c of [78, 98, 87, 89]) boxed[c] = 1; // around (8,8)
    walks.setGrid(boxed);
    walks.place([standAt("a", 9, 5)], 0);
    walks.place([standAt("a", 8, 8)], 0);
    expect(sample("a", 0)).toMatchObject({ ...cellCenter(8, 8), walking: false });
  });

  test("a new layout puts everyone straight at their new spot", () => {
    const { walks, sample } = setup();
    walks.place([sitAt("a", 1, 5)], 0);
    walks.setGrid(walkGrid(DEFAULT_LAYOUT));
    walks.place([sitAt("a", 7, 3)], 10);
    expect(sample("a", 10)).toMatchObject({ ...cellCenter(7, 3), walking: false });
  });

  test("someone who left is forgotten", () => {
    const { walks, sample } = setup();
    walks.place([standAt("a", 4, 9), standAt("b", 5, 9)], 0);
    walks.place([standAt("b", 5, 9)], 10);
    expect(sample("a", 10)).toBeNull();
    expect(sample("b", 10)).not.toBeNull();
  });

  test("rest time counts from arrival, and people placed together don't breathe in step", () => {
    const { walks, sample } = setup();
    walks.place([standAt("a", 4, 9), standAt("b", 5, 9), standAt("c", 6, 9)], 0);
    const rests = ["a", "b", "c"].map((w) => sample(w, 0)?.restMs);
    expect(new Set(rests).size).toBeGreaterThan(1);
    walks.place([standAt("a", 4, 8), standAt("b", 5, 9), standAt("c", 6, 9)], 100);
    expect(sample("a", 100 + TILE_MS + 50)?.restMs).toBe(50);
  });
});

test("a new target on the cell just ahead mid-step finishes the step instead of jumping", () => {
  const walks = createWalks({ reducedMotion: () => false });
  walks.setGrid(grid);
  const pose = emptyPose();
  walks.place([standAt("a", 9, 5)], 0);
  walks.place([standAt("a", 5, 5)], 0);
  walks.place([standAt("a", 8, 5)], 300); // half way to (8,5)
  walks.sample(id("a"), 300, pose);
  expect(pose.walking).toBe(true);
  walks.sample(id("a"), 600, pose);
  expect(pose).toMatchObject({ ...cellCenter(8, 5), walking: false });
});
