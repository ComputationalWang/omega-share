import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import { BATCH_MAX_MESSAGES, ClientMessageSchema, ServerMessageSchema, parseClientMessage, parseServerMessage } from "../src/index";

// Relay batching (OME-1624, ADR 0050 amendment): a connection that joins with `batch: true` may get relays
// coalesced into one `batch` frame. Never nested, 1..BATCH_MAX_MESSAGES messages.

const WALK = { type: "walked", memberId: "m1", cell: { x: 1, y: 2 } } as const;
const batch = (n: number, msg: unknown = WALK): unknown => ({ type: "batch", msgs: Array.from({ length: n }, () => msg) });

function rejects(input: unknown): void {
  expect(v.safeParse(ServerMessageSchema, input).success).toBe(false);
}

test("a batch holds at most 64 messages", () => {
  expect(BATCH_MAX_MESSAGES).toBe(64);
});

describe("server batch", () => {
  test.each([[1], [2], [BATCH_MAX_MESSAGES - 1], [BATCH_MAX_MESSAGES]])("accepts %p messages", (n) => {
    expect(parseServerMessage(JSON.stringify(batch(n)))).toEqual(batch(n));
  });

  test.each([[0], [BATCH_MAX_MESSAGES + 1]])("rejects %p messages", (n) => {
    rejects(batch(n));
  });

  test("mixes message types and parses each one", () => {
    const chat = { type: "chat", memberId: "m2", text: " hi ", at: 1 };
    expect(parseServerMessage(JSON.stringify({ type: "batch", msgs: [WALK, chat, { type: "emoted", memberId: "m1", kind: "clap" }] }))).toEqual({
      type: "batch",
      msgs: [WALK, { ...chat, text: "hi" }, { type: "emoted", memberId: "m1", kind: "clap" }],
    });
  });

  test("rejects a nested batch, a bad inner message and a non-array", () => {
    rejects(batch(1, batch(1)));
    rejects({ type: "batch", msgs: [WALK, { type: "walked", memberId: "a b", cell: null }] });
    rejects({ type: "batch", msgs: [WALK, { type: "join", nickname: "alice", avatar: 0 }] });
    rejects({ type: "batch", msgs: WALK });
    rejects({ type: "batch" });
  });
});

describe("join batch opt-in", () => {
  const join = { type: "join" as const, nickname: "alice", avatar: 0 };

  test("is an optional boolean", () => {
    expect(parseClientMessage(JSON.stringify({ ...join, batch: true }))).toEqual({ ...join, batch: true });
    expect(parseClientMessage(JSON.stringify({ ...join, batch: false }))).toEqual({ ...join, batch: false });
    expect(parseClientMessage(JSON.stringify(join))).toEqual(join);
  });

  test.each([["true"], [1], [null]])("rejects %p", (flag) => {
    expect(v.safeParse(ClientMessageSchema, { ...join, batch: flag }).success).toBe(false);
  });
});
