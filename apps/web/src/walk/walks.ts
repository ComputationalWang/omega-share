// Who walks where (OME-408). The server says who sits where; each client walks the avatars there itself, from the door
// (someone who joined) or from where they were. Time-based: a hidden tab that comes back finds everyone arrived.
// Avatars move in whole steps, one per walk frame (ADR 0010 `stepPx`), and every walk starts on a shared step clock, so
// all walkers step together and the room redraws at most once a step. A path is found once per target change;
// `sample` allocates nothing.
import type { MemberId } from "@omega/shared";
import { standDepth } from "../furniture";
import { TILE_H, TILE_W, type Point } from "../layout";
import { DOOR, cellAt, centerOf, colOf, findPath, rowOf } from "./path";

export type Dir = "se" | "sw" | "ne" | "nw";

/** ADR 0010 `meta.omega.walk`: 150 ms a frame, 4 frames a tile (one cycle per tile). motion.ts checks the atlas agrees. */
export const WALK_FRAME_MS = 150;
export const WALK_FRAMES = 4;
const TILE_MS = WALK_FRAME_MS * WALK_FRAMES;
/** Screen length of one step between neighbouring cells. */
const TILE_LEN = Math.hypot(TILE_W / 2, TILE_H / 2);
/** Spread of rest phases for people placed at once, so a room doesn't breathe in step. */
const REST_SPREAD_MS = 2400;

export interface WalkTarget {
  readonly id: MemberId;
  /** The floor point of their seat or standing spot. */
  readonly at: Point;
  /** Depth once there (a sitter takes their seat's). */
  readonly z: number;
  /** The seat's facing if they sit there, null if they stand. */
  readonly seatFacing: Dir | null;
}

/** Where to draw someone now. Filled in place by `sample`. */
export interface Pose {
  x: number;
  y: number;
  z: number;
  dir: Dir;
  walking: boolean;
  sitting: boolean;
  /** Walk frame, 0..3, while walking. */
  step: number;
  /** Time at rest (for the breathe cycle); 0 while walking. */
  restMs: number;
}

export const emptyPose = (): Pose => ({ x: 0, y: 0, z: 0, dir: "se", walking: false, sitting: false, step: 0, restMs: 0 });

export interface WalksOptions {
  readonly reducedMotion: () => boolean;
  /** Path finder (path.ts); a seam for counting calls. */
  readonly route?: (grid: Uint8Array, from: number, to: number) => number[] | null;
}

export interface Walks {
  /** The layout's walk grid (path.ts `walkGrid`). If it changed, everyone's next spot is taken without a walk. */
  setGrid(grid: Uint8Array): void;
  /** Everyone's spot now. The first call with people in it (my snapshot) places them without a walk. */
  place(targets: readonly WalkTarget[], now: number): void;
  /** Writes `id`'s pose at `now` into `out`; false if they're not in the room. */
  sample(id: MemberId, now: number, out: Pose): boolean;
  /** True while anyone is still on their way. */
  walking(now: number): boolean;
}

interface Entry {
  target: WalkTarget;
  /** Waypoints: xs, ys, the cell each one is (-1 for a start point between cells), and the time to reach it from `start`. */
  xs: number[];
  ys: number[];
  cells: number[];
  ts: number[];
  start: number;
  /** When they arrived (or will); rest time counts from here. */
  restAt: number;
}

/** Standing people face the TV in the back corner: ne left of the aisle, nw right of it (like seats, ADR 0008). */
const standFacing = (cell: number): Dir => (colOf(cell) < rowOf(cell) ? "ne" : "nw");

function dirOf(dx: number, dy: number): Dir {
  if (dy >= 0) return dx >= 0 ? "se" : "sw";
  return dx >= 0 ? "ne" : "nw";
}

function jitter(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h) % REST_SPREAD_MS;
}

/** The next tick of the shared step clock at or after `now`: when a walk asked for at `now` starts. */
const stepClock = (now: number): number => Math.ceil(now / WALK_FRAME_MS) * WALK_FRAME_MS;
/** Walk time rounded down to the step being shown; 0 before the walk starts. */
const stepTime = (t: number): number => (t <= 0 ? 0 : Math.floor(t / WALK_FRAME_MS) * WALK_FRAME_MS);

const sameTarget = (a: WalkTarget, b: WalkTarget): boolean => a.at.x === b.at.x && a.at.y === b.at.y && a.z === b.z && a.seatFacing === b.seatFacing;

export function createWalks(opts: WalksOptions): Walks {
  const route = opts.route ?? findPath;
  const entries = new Map<MemberId, Entry>();
  let grid: Uint8Array = new Uint8Array(0);
  let seeded = false;
  let snapNext = false;
  const scratch = emptyPose();

  const at = (t: WalkTarget, now: number, restAt = now): Entry => ({ target: t, xs: [], ys: [], cells: [], ts: [], start: now, restAt });
  const walkEnd = (e: Entry): number => e.start + (e.ts.at(-1) ?? 0);

  /** A walk to `t` from point (x, y), routed from cell `from`; `back` is the cell just left if that's mid-step. */
  function walk(e: Entry, t: WalkTarget, x: number, y: number, from: number, back: number, now: number): void {
    e.target = t;
    e.xs.length = e.ys.length = e.cells.length = e.ts.length = 0;
    const goal = cellAt(t.at);
    const path = goal < 0 || from < 0 ? null : route(grid, from, goal);
    if (path === null) {
      e.start = e.restAt = now;
      return;
    }
    // Turning round mid-step: head straight back to the cell just left.
    if (back >= 0 && path[1] === back) path.shift();
    e.xs.push(x);
    e.ys.push(y);
    e.cells.push(-1);
    e.ts.push(0);
    let px = x;
    let py = y;
    let ms = 0;
    for (const c of path) {
      const p = c === goal ? t.at : centerOf(c);
      const d = Math.hypot(p.x - px, p.y - py);
      if (d === 0) continue;
      ms += (d / TILE_LEN) * TILE_MS;
      e.xs.push(p.x);
      e.ys.push(p.y);
      e.cells.push(c);
      e.ts.push(ms);
      px = p.x;
      py = p.y;
    }
    if (ms === 0) e.xs.length = e.ys.length = e.cells.length = e.ts.length = 0;
    e.start = ms === 0 ? now : stepClock(now);
    e.restAt = e.start + ms;
  }

  function sampleEntry(e: Entry, now: number, out: Pose): void {
    const t = stepTime(now - e.start);
    const total = e.ts.at(-1) ?? 0;
    if (now - e.start < total) {
      let i = 1;
      while (i < e.ts.length - 1 && (e.ts[i] ?? 0) <= t) i++;
      const t0 = e.ts[i - 1] ?? 0;
      const t1 = e.ts[i] ?? 0;
      const x0 = e.xs[i - 1] ?? 0;
      const y0 = e.ys[i - 1] ?? 0;
      const x1 = e.xs[i] ?? 0;
      const y1 = e.ys[i] ?? 0;
      const f = (t - t0) / (t1 - t0);
      out.x = x0 + (x1 - x0) * f;
      out.y = y0 + (y1 - y0) * f;
      out.z = standDepth(out);
      out.dir = dirOf(x1 - x0, y1 - y0);
      out.walking = true;
      out.sitting = false;
      out.step = Math.floor(t / WALK_FRAME_MS) % WALK_FRAMES;
      out.restMs = 0;
      return;
    }
    const tg = e.target;
    out.x = tg.at.x;
    out.y = tg.at.y;
    out.z = tg.z;
    out.dir = tg.seatFacing ?? standFacing(cellAt(tg.at));
    out.walking = false;
    out.sitting = tg.seatFacing !== null;
    out.step = 0;
    out.restMs = now - e.restAt;
  }

  return {
    setGrid(g) {
      if (g.length === grid.length && g.every((b, i) => b === grid[i])) return;
      grid = g;
      snapNext = true;
    },
    place(targets, now) {
      const snap = !seeded || snapNext || opts.reducedMotion();
      if (targets.length > 0) seeded = true;
      snapNext = false;
      const seen = new Set<MemberId>();
      for (const t of targets) {
        seen.add(t.id);
        const e = entries.get(t.id);
        if (e === undefined) {
          const fresh = at(t, now, now - jitter(t.id));
          entries.set(t.id, fresh);
          if (!snap) {
            const door = centerOf(DOOR);
            walk(fresh, t, door.x, door.y, DOOR, -1, now);
          }
          continue;
        }
        if (sameTarget(e.target, t)) continue;
        if (snap) {
          e.target = t;
          e.xs.length = e.ys.length = e.cells.length = e.ts.length = 0;
          e.start = e.restAt = now;
          continue;
        }
        sampleEntry(e, now, scratch);
        if (!scratch.walking) {
          walk(e, t, scratch.x, scratch.y, cellAt(e.target.at), -1, now);
          continue;
        }
        // Mid-step between two cells: route from the one ahead, or turn back to the one behind.
        const tt = stepTime(now - e.start);
        let i = 1;
        while (i < e.ts.length - 1 && (e.ts[i] ?? 0) <= tt) i++;
        const ahead = e.cells[i] ?? -1;
        const behind = e.cells[i - 1] ?? -1;
        walk(e, t, scratch.x, scratch.y, ahead, behind >= 0 ? behind : cellAt({ x: e.xs[i - 1] ?? 0, y: e.ys[i - 1] ?? 0 }), now);
      }
      for (const id of entries.keys()) if (!seen.has(id)) entries.delete(id);
    },
    sample(id, now, out) {
      const e = entries.get(id);
      if (e === undefined) return false;
      sampleEntry(e, now, out);
      return true;
    },
    walking(now) {
      for (const e of entries.values()) if (walkEnd(e) > now) return true;
      return false;
    },
  };
}
