import { describe, expect, test } from "bun:test";
import { FLOOR_CELLS, type Member, type RoomState } from "@omega/shared";
import { hugStep } from "../src/chat/hug";
import { slashCommand } from "../src/chat/effects";
import { initialState, reduce, type ViewState } from "../src/state";
import { isPetting, petCell } from "../src/walk/pet";
import { cellOf } from "../src/walk/path";

// OME-1669: /pet walks me beside the cat and sends the existing heart; a heart from beside a cat is a pet.

const empty = (): Uint8Array => new Uint8Array(FLOOR_CELLS * FLOOR_CELLS);
const none: ReadonlySet<number> = new Set();

describe("slashCommand /pet", () => {
  test("/pet is the pet command, any case; with words after it, it's chat", () => {
    expect(slashCommand("/pet")).toEqual({ type: "pet" });
    expect(slashCommand("  /PET ")).toEqual({ type: "pet" });
    expect(slashCommand("/pet the cat")).toBeNull();
    expect(slashCommand("/pets")).toBeNull();
  });
});

describe("petCell", () => {
  test("the free cell beside the cat that I reach first", () => {
    expect(petCell(empty(), cellOf(5, 5), cellOf(9, 5), none)).toBe(cellOf(6, 5));
    expect(petCell(empty(), cellOf(5, 5), cellOf(5, 1), none)).toBe(cellOf(5, 4));
  });

  test("solid and taken cells are skipped; boxed in is null", () => {
    const g = empty();
    g[cellOf(6, 5)] = 1;
    expect(petCell(g, cellOf(5, 5), cellOf(9, 5), none)).not.toBe(cellOf(6, 5));
    const boxed = empty();
    for (const c of [cellOf(6, 5), cellOf(4, 5), cellOf(5, 6)]) boxed[c] = 1;
    expect(petCell(boxed, cellOf(5, 5), cellOf(9, 5), new Set([cellOf(5, 4)]))).toBeNull();
  });
});

describe("isPetting", () => {
  test("beside a cat, not on it, not diagonal, not far", () => {
    const cats = [cellOf(2, 2), cellOf(8, 8)];
    expect(isPetting(cellOf(2, 3), cats)).toBe(true);
    expect(isPetting(cellOf(7, 8), cats)).toBe(true);
    expect(isPetting(cellOf(2, 2), cats)).toBe(false);
    expect(isPetting(cellOf(3, 3), cats)).toBe(false);
    expect(isPetting(cellOf(5, 5), cats)).toBe(false);
    expect(isPetting(cellOf(2, 3), [])).toBe(false);
  });
});

describe("hugStep for the cat (no target member)", () => {
  const m = (id: string): Member => ({ id, nickname: id, avatar: 0 });
  const room: RoomState = { id: "lobby", seats: [null, null, null, null, null, null, null, null], members: [m("a")], embed: null };
  const open: ViewState = reduce(initialState, { type: "server", msg: { type: "snapshot", self: "a", room }, now: 0 });
  const walked = (s: ViewState, x: number, y: number): ViewState => reduce(s, { type: "server", msg: { type: "walked", memberId: "a", cell: { x, y } }, now: 0 });
  const start = walked(open, 9, 9);
  const pet = { target: null, cell: { x: 7, y: 9 } };

  test("arriving beside the cat arrives; walking elsewhere cancels; no walk yet waits", () => {
    expect(hugStep(start, walked(start, 7, 9), pet)).toBe("arrived");
    expect(hugStep(start, walked(start, 3, 3), pet)).toBe("cancel");
    expect(hugStep(start, start, pet)).toBeNull();
  });
});
