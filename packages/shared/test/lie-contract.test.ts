import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import {
  ClientMessageSchema,
  FURNITURE,
  FURNITURE_KINDS,
  LIE_STYLES,
  MAX_FURNITURE,
  MemberSchema,
  PieceIndexSchema,
  ServerMessageSchema,
  parseClientMessage,
  parseServerMessage,
} from "../src/index";

// Lying on a sofa or couch, curling up on the cat (OME-1773 for OME-1691).

function rejects(schema: v.GenericSchema, input: unknown): void {
  expect(v.safeParse(schema, input).success).toBe(false);
}

describe("catalogue lie style", () => {
  test("the sofa and couch take a lier, the cat a curl; nothing else", () => {
    expect(LIE_STYLES).toEqual(["lie", "curl"]);
    const styled = Object.fromEntries(FURNITURE_KINDS.flatMap((kind) => (FURNITURE[kind].lie ? [[kind, FURNITURE[kind].lie]] : [])));
    expect(styled).toEqual({ sofa: "lie", couch: "lie", cat: "curl" });
  });

  test("the cat stays a non-seat, so seat indices don't move", () => {
    expect(FURNITURE.cat.seats).toBe(false);
  });
});

describe("piece index", () => {
  test("an integer in 0..MAX_FURNITURE", () => {
    for (const i of [0, MAX_FURNITURE - 1]) expect(v.parse(PieceIndexSchema, i)).toBe(i);
    for (const i of [-1, MAX_FURNITURE, 0.5, "1", null]) rejects(PieceIndexSchema, i);
  });
});

describe("lie", () => {
  test("client lie takes a piece index or null, and nothing else", () => {
    for (const piece of [0, 31, null]) expect(parseClientMessage(JSON.stringify({ type: "lie", piece }))).toEqual({ type: "lie", piece });
    for (const piece of [-1, 32, 1.5, "1", true]) rejects(ClientMessageSchema, { type: "lie", piece });
    rejects(ClientMessageSchema, { type: "lie" });
    rejects(ClientMessageSchema, { type: "lie", piece: 1, seat: 0 });
  });

  test("server lay names the member and the piece, null to get up", () => {
    for (const piece of [3, null]) {
      const msg = { type: "lay", memberId: "m1", piece } as const;
      expect(parseServerMessage(JSON.stringify(msg))).toEqual(msg);
    }
    rejects(ServerMessageSchema, { type: "lay", memberId: "m1", piece: 32 });
    rejects(ServerMessageSchema, { type: "lay", memberId: "m1" });
    rejects(ServerMessageSchema, { type: "lay", piece: 1 });
  });

  test("a member may carry lying (absent means not lying)", () => {
    const member = { id: "m1", nickname: "alice", avatar: 0 };
    expect(v.parse(MemberSchema, { ...member, lying: 4 })).toEqual({ ...member, lying: 4 });
    expect(v.parse(MemberSchema, member)).toEqual(member);
    for (const lying of [null, 32, true]) rejects(MemberSchema, { ...member, lying });
  });
});
