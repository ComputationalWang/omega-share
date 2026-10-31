import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as v from "valibot";
import { FURNITURE, RoomLayoutInputSchema, RoomLayoutSchema, isScreen, onFixture } from "../src/index";

// Wave 2 kinds (OME-2085, ADR 0058 amendment): tripod, window, longclock, lavalamp, the v8 colourways, and wall
// fixtures that exist only in the default shell.

const CHAIRS = ([[1, 5], [2, 4], [4, 2], [5, 1], [3, 7], [4, 6], [6, 4], [7, 3]] as const).map(([col, row]) => ({ kind: "armchair", col, row, facing: "ne" }));
const TV = { kind: "tv", col: 0, row: 0, facing: "se" } as const;
const room = (...furniture: unknown[]): { furniture: unknown[] } => ({ furniture: [TV, ...CHAIRS, ...furniture] });
const ok = (input: unknown): boolean => v.safeParse(RoomLayoutInputSchema, input).success && v.safeParse(RoomLayoutSchema, input).success;
const spec = (k: string): unknown => (FURNITURE as Record<string, unknown>)[k];

describe("the four wave 2 kinds", () => {
  test("tripod, window, longclock and lavalamp follow the ADR 0058 amendment", () => {
    expect(spec("tripod")).toMatchObject({ layer: "object", facings: ["ne", "nw", "se", "sw"], cols: 1, rows: 1, seats: false, variants: 1, wallBacked: false });
    expect(spec("window")).toMatchObject({ layer: "wall", facings: ["se", "sw"], cols: 0, rows: 0, seats: false, variants: 2, wallBacked: false });
    expect(spec("longclock")).toMatchObject({ layer: "object", facings: ["se", "sw"], cols: 1, rows: 1, seats: false, variants: 1, wallBacked: true });
    expect(spec("lavalamp")).toMatchObject({ layer: "object", facings: ["se"], cols: 1, rows: 1, seats: false, variants: 1, wallBacked: false });
  });

  test("none of them is a screen", () => {
    for (const k of ["tripod", "window", "longclock", "lavalamp"] as const) expect(isScreen(k)).toBe(false);
  });

  test("a window hangs on a wall, a long-case clock backs onto one", () => {
    expect(ok(room({ kind: "window", col: 2, row: 0, facing: "sw", variant: 1 }))).toBe(true);
    expect(ok(room({ kind: "window", col: 2, row: 1, facing: "sw" }))).toBe(false);
    expect(ok(room({ kind: "longclock", col: 0, row: 3, facing: "se" }))).toBe(true);
    expect(ok(room({ kind: "longclock", col: 3, row: 3, facing: "se" }))).toBe(false);
    expect(ok(room({ kind: "tripod", col: 8, row: 8, facing: "nw" }, { kind: "lavalamp", col: 9, row: 9, facing: "se" }))).toBe(true);
  });
});

test("v8 colourways: sidetable 2, barcounter 3, speaker 3", () => {
  expect(FURNITURE.sidetable.variants).toBe(2);
  expect(FURNITURE.barcounter.variants).toBe(3);
  expect(FURNITURE.speaker.variants).toBe(3);
});

describe("wall fixtures exist only in the default shell", () => {
  const frame = { kind: "frame", col: 5, row: 0, facing: "sw" };
  const span = { kind: "wallscreen", col: 5, row: 0, facing: "sw" };
  const noTv = (more: unknown, shell?: string): unknown => ({ furniture: [...CHAIRS, more], ...(shell === undefined ? {} : { shell }) });

  test("a wall piece on segments 5–6 is refused without a shell", () => {
    expect(ok(room(frame))).toBe(false);
    expect(ok(noTv(span))).toBe(false);
  });

  test("and accepted with a shell", () => {
    expect(ok({ ...room(frame), shell: "penthouse" })).toBe(true);
    expect(ok(noTv(span, "penthouse"))).toBe(true);
    expect(ok(noTv(span, "studio"))).toBe(true);
  });

  test("the span still has to stay on the 10 segments", () => {
    expect(ok(noTv({ kind: "wallscreen", col: 9, row: 0, facing: "sw" }, "penthouse"))).toBe(false);
  });

  test("onFixture names the wall pieces over a fixture segment", () => {
    expect(onFixture({ kind: "frame", col: 5, row: 0, facing: "sw" })).toBe(true);
    expect(onFixture({ kind: "projector", col: 0, row: 3, facing: "se" })).toBe(true);
    expect(onFixture({ kind: "frame", col: 4, row: 0, facing: "sw" })).toBe(false);
    expect(onFixture({ kind: "bookshelf", col: 5, row: 0, facing: "sw" })).toBe(false);
  });
});

// The v8 atlas (PR #777, `assets/furniture/furniture-v8.json`): its new kinds' dirs and colours are the contract's
// facings and variants; its recolours are the last variants of kinds that already have art.
test("the v8 atlas pins the wave 2 kinds and colourways", () => {
  const atlas = JSON.parse(readFileSync(new URL("../../../assets/furniture/furniture-v8.json", import.meta.url), "utf8")) as {
    meta: { omega: { pieces: { id: string; dirs: string[]; colours: string[]; wallSpan?: number }[] } };
  };
  const extra: Record<string, number> = { sidetable: 1, barcounter: 2, speaker: 1 };
  for (const p of atlas.meta.omega.pieces) {
    const s = spec(p.id) as { facings: string[]; variants: number; wallSpan?: number };
    if (extra[p.id] === undefined) {
      expect(s.variants, p.id).toBe(p.colours.length);
      expect(s.facings, p.id).toEqual(p.dirs);
    } else expect(p.colours.length, p.id).toBe(extra[p.id]);
    expect(s.wallSpan, p.id).toBe(p.wallSpan);
  }
});
