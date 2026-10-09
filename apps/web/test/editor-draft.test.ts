import { describe, expect, test } from "bun:test";
import { DEFAULT_LAYOUT, FURNITURE, FURNITURE_KINDS, MAX_FURNITURE, RoomLayoutSchema, type RoomLayout } from "@omega/shared";
import * as v from "valibot";
import { TRAY_TABS, defaultFacing, fits, move, pieceAt, place, problemText, problems, remove, rotate } from "../src/editor/draft";

// DEFAULT_LAYOUT indices: 0 tv, 1 rug, 2..9 armchairs ([1,5] [2,4] [4,2] [5,1] [3,7] [4,6] [6,4] [7,3]), 10 lamp, 11 plant.
const L = DEFAULT_LAYOUT;

describe("pieceAt", () => {
  test("an armchair cell gives the armchair, not the rug under it", () => {
    expect(pieceAt(L, 1, 5)).toBe(2);
  });
  test("a rug-only cell gives the rug", () => {
    expect(pieceAt(L, 3, 3)).toBe(1);
  });
  test("an object beats the floor piece under it (tv on the rug corner)", () => {
    expect(pieceAt(L, 0, 0)).toBe(0);
  });
  test("an empty cell gives null", () => {
    expect(pieceAt(L, 9, 9)).toBeNull();
  });
  test("a wall piece is found at its anchor", () => {
    const withFrame = place(L, { kind: "frame", col: 3, row: 0, facing: "sw" });
    expect(withFrame).not.toBeNull();
    expect(pieceAt(withFrame ?? L, 3, 0)).toBe(12);
  });
  test("a multi-cell piece is found on its second cell", () => {
    const l: RoomLayout = { furniture: [...remove(remove(L, 3), 2).furniture, { kind: "sofa", col: 1, row: 5, facing: "ne" }] };
    expect(pieceAt(l, 2, 5)).toBe(l.furniture.length - 1);
  });
});

describe("rotate", () => {
  test("an armchair goes ne to nw at the same anchor and index", () => {
    const r = rotate(L, 2);
    expect(r?.furniture[2]).toEqual({ kind: "armchair", col: 1, row: 5, facing: "nw" });
    expect(r?.furniture.length).toBe(L.furniture.length);
  });
  test("the one-facing tv cannot rotate", () => {
    expect(rotate(L, 0)).toBeNull();
  });
  test("a wall-backed bookshelf only takes a facing that keeps it on its wall", () => {
    const l = place(L, { kind: "bookshelf", col: 2, row: 0, facing: "sw" });
    expect(l).not.toBeNull();
    expect(rotate(l ?? L, 12)).toBeNull();
  });
  test("does not mutate its input", () => {
    rotate(L, 2);
    expect(L.furniture[2]?.facing).toBe("ne");
  });
});

describe("move", () => {
  test("onto another armchair is refused", () => {
    expect(move(L, 2, 4, 2)).toBeNull();
  });
  test("to a free cell keeps the index", () => {
    const m = move(L, 2, 8, 8);
    expect(m?.furniture[2]).toEqual({ kind: "armchair", col: 8, row: 8, facing: "ne" });
  });
  test("off the floor is refused", () => {
    expect(move(L, 2, 10, 5)).toBeNull();
  });
  test("a piece may move onto the cell it already holds (skips itself)", () => {
    expect(move(L, 2, 1, 5)).toEqual(L);
  });
});

describe("remove, place, problems", () => {
  test("removing an armchair leaves 7 of 8 seats", () => {
    expect(problems(remove(L, 2))).toEqual([{ code: "seats", have: 7, need: 8 }]);
    expect(problemText({ code: "seats", have: 7, need: 8 })).toBe("7 of 8 seats: add 1 more seat");
  });
  test("a default layout has no problems", () => {
    expect(problems(L)).toEqual([]);
  });
  test("a sofa replaces two armchairs", () => {
    const fewer = remove(remove(L, 3), 2);
    expect(problems(fewer)).toEqual([{ code: "seats", have: 6, need: 8 }]);
    const withSofa = place(fewer, { kind: "sofa", col: 1, row: 5, facing: "ne" });
    expect(withSofa).not.toBeNull();
    expect(problems(withSofa ?? fewer)).toEqual([]);
  });
  test("placing on an occupied cell is refused", () => {
    expect(place(L, { kind: "plant", col: 1, row: 5, facing: "se" })).toBeNull();
  });
  test("a runner beside the rug fits, one on the rug does not", () => {
    expect(place(L, { kind: "runner", col: 8, row: 5, facing: "nw" })).not.toBeNull();
    expect(place(L, { kind: "runner", col: 3, row: 3, facing: "ne" })).toBeNull();
  });
  test("a second tv is placeable but reported", () => {
    const l = place(L, { kind: "tv", col: 9, row: 9, facing: "se" });
    expect(l).not.toBeNull();
    expect(problems(l ?? L)).toEqual([{ code: "tv", have: 2 }]);
    expect(problemText({ code: "tv", have: 2 })).toBe("The room needs exactly one TV");
  });
  test("no tv is reported", () => {
    expect(problems(remove(L, 0))).toEqual([{ code: "tv", have: 0 }]);
  });
  test("an overlap in a hand-built layout is reported", () => {
    const l: RoomLayout = { furniture: [...L.furniture, { kind: "plant", col: 1, row: 5, facing: "se" }] };
    expect(problems(l)).toContainEqual({ code: "overlap" });
  });
  test("the cap is enforced by place and reported by problems", () => {
    let l: RoomLayout = L;
    for (let r = 1; r < 9 && l.furniture.length < MAX_FURNITURE; r++) {
      for (const c of [8, 9]) {
        if (l.furniture.length < MAX_FURNITURE) l = place(l, { kind: "plant", col: c, row: r, facing: "se" }) ?? l;
      }
    }
    expect(l.furniture.length).toBe(MAX_FURNITURE);
    expect(place(l, { kind: "frame", col: 3, row: 0, facing: "sw" })).toBeNull();
    const over: RoomLayout = { furniture: [...l.furniture, { kind: "frame", col: 3, row: 0, facing: "sw" }] };
    expect(problems(over)).toContainEqual({ code: "too-many", have: MAX_FURNITURE + 1, max: MAX_FURNITURE });
  });
  test("problems is empty exactly when the schema accepts", () => {
    const dup = L.furniture[2];
    const samples: RoomLayout[] = [L, remove(L, 2), remove(L, 0), { furniture: [] }];
    if (dup) samples.push({ furniture: [...L.furniture, dup] });
    for (const s of samples) expect(problems(s).length === 0).toBe(v.safeParse(RoomLayoutSchema, s).success);
  });
});

describe("fits", () => {
  test("a frame on a fixture segment does not fit", () => {
    expect(fits(L, { kind: "frame", col: 5, row: 0, facing: "sw" })).toBe(false);
    expect(fits(L, { kind: "frame", col: 0, row: 6, facing: "se" })).toBe(false);
  });
  test("a frame on a plain segment fits", () => {
    expect(fits(L, { kind: "frame", col: 3, row: 0, facing: "sw" })).toBe(true);
  });
  test("two frames on one segment collide", () => {
    const l = place(L, { kind: "frame", col: 3, row: 0, facing: "sw" });
    expect(fits(l ?? L, { kind: "frame", col: 3, row: 0, facing: "sw" })).toBe(false);
    expect(fits(l ?? L, { kind: "frame", col: 3, row: 0, facing: "sw" }, 12)).toBe(true);
  });
  test("a frame needs its wall", () => {
    expect(fits(L, { kind: "frame", col: 3, row: 2, facing: "sw" })).toBe(false);
  });
  test("a disallowed facing or variant does not fit", () => {
    expect(fits(L, { kind: "lamp", col: 8, row: 8, facing: "ne" })).toBe(false);
    expect(fits(L, { kind: "lamp", col: 8, row: 8, facing: "se", variant: 1 })).toBe(false);
    expect(fits(L, { kind: "beanbag", col: 8, row: 8, facing: "se", variant: 1 })).toBe(true);
  });
  test("a piece whose footprint leaves the floor does not fit", () => {
    expect(fits(L, { kind: "sofa", col: 9, row: 8, facing: "ne" })).toBe(false);
  });
});

describe("defaultFacing", () => {
  test("wall pieces pick the wall they are on", () => {
    expect(defaultFacing("frame", 3, 0)).toBe("sw");
    expect(defaultFacing("frame", 0, 3)).toBe("se");
    expect(defaultFacing("frame", 0, 0)).toBe("sw");
    expect(defaultFacing("bookshelf", 0, 4)).toBe("se");
  });
  test("others take their first facing", () => {
    expect(defaultFacing("armchair", 4, 4)).toBe("ne");
    expect(defaultFacing("sidetable", 4, 4)).toBe("se");
    expect(defaultFacing("runner", 4, 4)).toBe("ne");
  });
});

describe("TRAY_TABS", () => {
  test("every kind is in exactly one tab", () => {
    const all: string[] = TRAY_TABS.flatMap((t) => [...t.kinds]);
    expect([...all].sort()).toEqual([...FURNITURE_KINDS].sort());
  });
  test("tab contents follow the catalogue", () => {
    expect(TRAY_TABS.map((t) => t.label)).toEqual(["Seats", "Decor", "Floor & wall"]);
    const tab = (id: string): readonly string[] => TRAY_TABS.find((t) => t.id === id)?.kinds ?? [];
    expect(tab("seats")).toContain("sofa");
    expect(TRAY_TABS[0]?.kinds.every((k) => FURNITURE[k].seats)).toBe(true);
    expect(tab("decor")).toContain("tv");
    expect(tab("floor")).toEqual(expect.arrayContaining(["rug", "runner", "frame"]));
  });
});

