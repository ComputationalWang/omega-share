import { describe, expect, test } from "bun:test";
import { chatView, refusalCard } from "../src/controls/feedback";
import { initialState, reduce, type ViewState } from "../src/state";

const open: ViewState = reduce(initialState, {
  type: "server",
  msg: { type: "snapshot", self: "a", room: { id: "lobby", seats: [null, null, null, null, null, null, null, null], members: [], embed: null } },
  now: 0,
});
const limited = (s: ViewState, now: number, retryAfterMs: number): ViewState =>
  reduce(s, { type: "server", msg: { type: "error", code: "rate_limited", message: "slow", retryAfterMs }, now });

describe("refusalCard (placeholder until the set (f) chrome, OME-193)", () => {
  test("nickname_taken: says the name is taken and sends the user back to pick another", () => {
    expect(refusalCard("nickname_taken")).toEqual({
      title: "That name is taken",
      body: "Someone in this room already uses that name, or one that looks the same. Pick another name to join.",
      action: "Pick another name",
    });
  });

  test("too_many_members: blames the network, not the user, and offers a retry", () => {
    expect(refusalCard("too_many_members")).toEqual({
      title: "Too many people from your network",
      body: "This room already has as many people from your network as it allows. Try again later, or join from another connection.",
      action: "Try again",
    });
  });
});

describe("chatView", () => {
  test("normally: chat is open with the usual placeholder", () => {
    expect(chatView(open, 0)).toEqual({ cooling: false, placeholder: "Say something…" });
  });

  test("while rate-limited: chat is held with a slow-down placeholder, then reopens on time", () => {
    const s = limited(open, 1000, 2000);
    expect(chatView(s, 1500)).toEqual({ cooling: true, placeholder: "Slow down a moment…" });
    expect(chatView(s, 3000)).toEqual({ cooling: false, placeholder: "Say something…" });
  });
});
