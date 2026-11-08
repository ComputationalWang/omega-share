import { beforeEach, describe, expect, test } from "bun:test";
import type { ClientMessage } from "@omega/shared";
import { createChatOutbox } from "../src/chat-outbox";

// OME-2425: a chat line the room never answered is resent after the rejoin, never silently dropped.
let sent: ClientMessage[];
let up: boolean;
const outbox = () =>
  createChatOutbox((m) => {
    if (!up) return false;
    sent.push(m);
    return true;
  });
const line = (text: string): ClientMessage => ({ type: "chat", text });

beforeEach(() => {
  sent = [];
  up = true;
});

describe("createChatOutbox", () => {
  test("sends through, and says so; a closed socket sends and keeps nothing", () => {
    const o = outbox();
    expect(o.send(line("hi"))).toBe(true);
    expect(o.send({ type: "typing", on: true })).toBe(true);
    expect(sent).toEqual([line("hi"), { type: "typing", on: true }]);
    up = false;
    expect(o.send(line("lost?"))).toBe(false);
    up = true;
    sent = [];
    o.resend();
    expect(sent).toEqual([line("hi")]);
  });

  test("my own echo or a refusal answers the oldest line; others' lines don't", () => {
    const o = outbox();
    o.send(line("one"));
    o.send(line("two"));
    o.send(line("three"));
    o.onServer({ type: "chat", memberId: "m2", text: "one", at: 1 }, "m1");
    o.onServer({ type: "chat", memberId: "m1", text: "one", at: 1 }, "m1");
    o.onServer({ type: "error", code: "muted", message: "x" }, "m1");
    sent = [];
    o.resend();
    expect(sent).toEqual([line("three")]);
    // Resent lines wait for their echo again.
    sent = [];
    o.resend();
    expect(sent).toEqual([line("three")]);
    o.onServer({ type: "chat", memberId: "m1", text: "three", at: 2 }, "m1");
    sent = [];
    o.resend();
    expect(sent).toEqual([]);
  });

  test("a rate_limited refusal answers a line too", () => {
    const o = outbox();
    o.send(line("fast"));
    o.onServer({ type: "error", code: "rate_limited", message: "x", retryAfterMs: 500 }, "m1");
    o.resend();
    expect(sent).toEqual([line("fast")]);
  });
});
