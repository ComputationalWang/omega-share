import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import {
  ClientMessageSchema,
  DEFAULT_LAYOUT,
  ERROR_CODES,
  PAIR_INVITE_TTL_MS,
  PAIR_POSES,
  RoomLayoutInputSchema,
  RoomLayoutSchema,
  ServerMessageSchema,
  parseClientMessage,
  parseServerMessage,
} from "../src/index";

// The dank-dungeon /thrust + /bendover pair (OME-1671 for OME-1664).

function rejects(schema: v.GenericSchema, input: unknown): void {
  expect(v.safeParse(schema, input).success).toBe(false);
}

describe("pair", () => {
  test("two poses; an invite lasts a minute", () => {
    expect(PAIR_POSES).toEqual(["thrust", "bendover"]);
    expect(PAIR_INVITE_TTL_MS).toBe(60_000);
  });

  test("client pair takes a pose and nothing else", () => {
    for (const pose of PAIR_POSES) expect(parseClientMessage(JSON.stringify({ type: "pair", pose }))).toEqual({ type: "pair", pose });
    for (const pose of ["Thrust", "hug", "", null, 0]) rejects(ClientMessageSchema, { type: "pair", pose });
    rejects(ClientMessageSchema, { type: "pair" });
    rejects(ClientMessageSchema, { type: "pair", pose: "thrust", memberId: "m2" });
  });

  test("server pair-invited names the member and their pose", () => {
    const msg = { type: "pair-invited", memberId: "m1", pose: "bendover" } as const;
    expect(parseServerMessage(JSON.stringify(msg))).toEqual(msg);
    rejects(ServerMessageSchema, { type: "pair-invited", memberId: "m1", pose: "hug" });
    rejects(ServerMessageSchema, { type: "pair-invited", pose: "thrust" });
  });

  test("server paired names both members by pose", () => {
    const msg = { type: "paired", thrust: "m1", bendover: "m2" } as const;
    expect(parseServerMessage(JSON.stringify(msg))).toEqual(msg);
    rejects(ServerMessageSchema, { type: "paired", thrust: "m1" });
    rejects(ServerMessageSchema, { type: "paired", thrust: "", bendover: "m2" });
  });

  test("pairs_off is an error code", () => {
    expect(ERROR_CODES).toContain("pairs_off");
    const msg = { type: "error", code: "pairs_off", message: "not in this room" } as const;
    expect(parseServerMessage(JSON.stringify(msg))).toEqual(msg);
  });
});

describe("layout pairs flag", () => {
  test("optional boolean on input and output; absent stays absent", () => {
    for (const pairs of [true, false]) {
      const layout = { ...DEFAULT_LAYOUT, pairs };
      expect(v.parse(RoomLayoutInputSchema, layout)).toEqual(layout);
      expect(v.parse(RoomLayoutSchema, layout)).toEqual(layout);
    }
    expect(v.parse(RoomLayoutSchema, DEFAULT_LAYOUT)).not.toHaveProperty("pairs");
  });

  test.each([["true"], [1], [null]])("refuses pairs %p", (pairs) => {
    rejects(RoomLayoutInputSchema, { ...DEFAULT_LAYOUT, pairs });
    rejects(RoomLayoutSchema, { ...DEFAULT_LAYOUT, pairs });
  });
});
