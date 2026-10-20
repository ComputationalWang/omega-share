import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import { CONGA_CAP, CONGA_WINDOW_MS, ServerMessageSchema, parseServerMessage } from "../src/index";

// The /conga line in the snapshot (OME-1574): a late joiner can't rebuild it from chat, so the server hands it over.

const ROOM = { id: "lobby", seats: [null, null, null, null, null, null, null, null], members: [{ id: "m1", nickname: "alice", avatar: 0 }], embed: null };
const snap = (extra: Record<string, unknown>) => ({ type: "snapshot", self: "m1", room: ROOM, ...extra });

test("12 people, a 2-minute window", () => {
  expect(CONGA_CAP).toBe(12);
  expect(CONGA_WINDOW_MS).toBe(120_000);
});

describe("snapshot conga", () => {
  test("carries the line, leader first, and the server time of the last join", () => {
    const conga = { ids: ["m1", "m2", "m3"], last: 1_800_000_000_000 };
    expect<unknown>(parseServerMessage(JSON.stringify(snap({ conga })))).toEqual(snap({ conga }));
  });

  test("absent means no line", () => {
    expect<unknown>(parseServerMessage(JSON.stringify(snap({})))).toEqual(snap({}));
  });

  const ids = (n: number) => Array.from({ length: n }, (_, i) => `m${String(i)}`);
  test.each([
    ["empty", { ids: [], last: 0 }],
    ["over the cap", { ids: ids(CONGA_CAP + 1), last: 0 }],
    ["a duplicate", { ids: ["m1", "m2", "m1"], last: 0 }],
    ["a bad id", { ids: ["a b"], last: 0 }],
    ["a negative time", { ids: ["m1"], last: -1 }],
    ["no time", { ids: ["m1"] }],
    ["null", null],
  ])("rejects %s", (_, conga) => {
    expect(v.safeParse(ServerMessageSchema, snap({ conga })).success).toBe(false);
  });

  test("the cap itself is fine", () => {
    expect(v.safeParse(ServerMessageSchema, snap({ conga: { ids: ids(CONGA_CAP), last: 0 } })).success).toBe(true);
  });
});
