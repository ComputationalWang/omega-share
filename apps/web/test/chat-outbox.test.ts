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

  test("my own echo answers its line and the earlier ones the room refused; others' lines don't", () => {
    const o = outbox();
    o.send(line("one"));
    o.send(line("two"));
    o.send(line("three"));
    o.onServer({ type: "chat", memberId: "m2", text: "two", at: 1 }, "m1");
    // "one" was refused without a notice (a rate-limit streak only says so once): the room handles lines in order.
    o.onServer({ type: "chat", memberId: "m1", text: "two", at: 1 }, "m1");
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

  test("the echo matches the line as the room stores it, trimmed and NFC, and answers one copy only", () => {
    const o = outbox();
    o.send(line("  cafe\u0301 "));
    o.send(line("hi"));
    o.send(line("hi"));
    o.onServer({ type: "chat", memberId: "m1", text: "caf\u00e9", at: 1 }, "m1");
    o.onServer({ type: "chat", memberId: "m1", text: "hi", at: 1 }, "m1");
    sent = [];
    o.resend();
    expect(sent).toEqual([line("hi")]);
  });

  test("OME-2475: a rate_limited for another frame doesn't eat the line when the socket dies before its echo", () => {
    const o = outbox();
    o.send(line("keep me"));
    o.send({ type: "sit", seat: 1 });
    o.onServer({ type: "error", code: "rate_limited", message: "x", retryAfterMs: 500 }, "m1");
    sent = [];
    o.resend();
    expect(sent).toEqual([line("keep me")]);
    o.onServer({ type: "chat", memberId: "m1", text: "keep me", at: 1 }, "m1");
    sent = [];
    o.resend();
    expect(sent).toEqual([]);
  });

  test("muted answers every line in flight: the room refuses them all", () => {
    const o = outbox();
    o.send(line("one"));
    o.send(line("two"));
    o.onServer({ type: "error", code: "muted", message: "x" }, "m1");
    sent = [];
    o.resend();
    expect(sent).toEqual([]);
  });
});
