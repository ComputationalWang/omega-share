import { describe, expect, test } from "bun:test";
import { CONGA_CAP, CONGA_WINDOW_MS, type RoomState } from "@omega/shared";
import { NO_CONGA, congaAhead, congaJoin, congaLeave, congaPrune, congaText, type Conga } from "../src/chat/conga";
import { initialState, reduce } from "../src/state";
import { HELP_LINE } from "../src/chat/effects";

const join = (line: Conga, id: string, at: number): Conga => {
  const next = congaJoin(line, id, at);
  if (next === "full") throw new Error("full");
  return next;
};
const abc = join(join(join(NO_CONGA, "a", 0), "b", 1000), "c", 2000);

// OME-1564
describe("congaText", () => {
  test("/help lists /conga and /stop", () => {
    expect(HELP_LINE.verb).toContain("/conga");
    expect(HELP_LINE.verb).toContain("/stop");
  });

  test("/conga joins, /stop leaves, anything else is chat", () => {
    expect(congaText("/conga")).toBe("conga");
    expect(congaText("  /CONGA let's go")).toBe("conga");
    expect(congaText("/stop")).toBe("stop");
    expect(congaText("/congas")).toBeNull();
    expect(congaText("/stop it")).toBeNull();
    expect(congaText("conga")).toBeNull();
  });
});

describe("the conga line", () => {
  test("the first sender leads, each later one follows the one before", () => {
    expect(abc.ids).toEqual(["a", "b", "c"]);
    expect(congaAhead(abc, "a")).toBeNull();
    expect(congaAhead(abc, "b")).toBe("a");
    expect(congaAhead(abc, "c")).toBe("b");
    expect(congaAhead(abc, "z")).toBeNull();
    expect(congaAhead(abc, null)).toBeNull();
  });

  test("sending /conga again keeps my place", () => {
    expect(join(abc, "a", 3000).ids).toEqual(["a", "b", "c"]);
  });

  test("within 2 minutes of the last join it grows; after that a new line starts", () => {
    expect(join(abc, "d", 2000 + CONGA_WINDOW_MS).ids).toEqual(["a", "b", "c", "d"]);
    expect(join(abc, "d", 2001 + CONGA_WINDOW_MS).ids).toEqual(["d"]);
    expect(join(abc, "b", 2001 + CONGA_WINDOW_MS).ids).toEqual(["b"]);
  });

  test("someone leaving mid-line closes it up", () => {
    const ac = congaLeave(abc, "b");
    expect(ac.ids).toEqual(["a", "c"]);
    expect(congaAhead(ac, "c")).toBe("a");
    expect(congaLeave(abc, "z")).toBe(abc);
    expect(congaAhead(congaLeave(abc, "a"), "b")).toBeNull();
  });

  test("capped at 12: the 13th sender is turned away", () => {
    let line = NO_CONGA;
    for (let i = 0; i < CONGA_CAP; i++) line = join(line, `m${String(i)}`, i);
    expect(line.ids).toHaveLength(12);
    expect(congaJoin(line, "late", 20)).toBe("full");
    expect(join(line, "m0", 20).ids).toHaveLength(12);
  });

  test("leaving the room or sitting down takes them out", () => {
    const room: RoomState = {
      id: "lobby",
      seats: ["c", null],
      members: [
        { id: "a", nickname: "alice", avatar: 0 },
        { id: "c", nickname: "cy", avatar: 1 },
        { id: "d", nickname: "di", avatar: 1, floorSit: true },
      ],
      embed: null,
    };
    const s = reduce(initialState, { type: "server", msg: { type: "snapshot", self: "a", room }, now: 0 });
    expect(congaPrune(join(abc, "d", 2500), s).ids).toEqual(["a"]);
    const kept = join(NO_CONGA, "a", 0);
    expect(congaPrune(kept, s)).toBe(kept);
  });
});
