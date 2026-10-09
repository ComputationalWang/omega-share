import { describe, expect, test } from "bun:test";
import { chatView, kickedCard, refusalCard } from "../src/controls/feedback";
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
    expect(chatView(open, 0)).toEqual({ cooling: false, muted: false, placeholder: "Say something…" });
  });

  test("while rate-limited: chat is held with a slow-down placeholder, then reopens on time", () => {
    const s = limited(open, 1000, 2000);
    expect(chatView(s, 1500)).toEqual({ cooling: true, muted: false, placeholder: "Slow down a moment…" });
    expect(chatView(s, 3000)).toEqual({ cooling: false, muted: false, placeholder: "Say something…" });
  });
});

describe("chatView: muted by the host (ADR 0030)", () => {
  test("my chat is muted: the field says why and Send is held, whatever the cooldown says", () => {
    const s = reduce(open, { type: "server", msg: { type: "member-joined", member: { id: "a", nickname: "me", avatar: 0 } }, now: 0 });
    const muted = reduce(limited(s, 0, 5000), { type: "server", msg: { type: "member-muted", memberId: "a", muted: true }, now: 0 });
    expect(chatView(muted, 100)).toEqual({ cooling: true, muted: true, placeholder: "The host muted your chat" });
    const unmuted = reduce(muted, { type: "server", msg: { type: "member-muted", memberId: "a", muted: false }, now: 0 });
    expect(chatView(unmuted, 9000)).toEqual({ cooling: false, muted: false, placeholder: "Say something…" });
  });
});

describe("refusalCard: private rooms (ADR 0028)", () => {
  test("invite_required: says the room is private and that an invite link gets you in", () => {
    const card = refusalCard("invite_required");
    expect(card.title).toBe("This room is private");
    expect(card.body).toContain("invite link");
  });
});

describe("kickedCard (ADR 0030, set j \"you were removed\")", () => {
  test("during the cooldown: the wait in words and a waiting Rejoin key, rounded up to whole minutes", () => {
    expect(kickedCard(600_000, 0)).toEqual({
      title: "You were removed from this room",
      body: "The host asked you to leave. You can come back in 10 minutes.",
      rejoin: "Rejoin in 10 min",
      ready: false,
      nextChangeMs: 60_000,
    });
    expect(kickedCard(600_000, 121_000)).toMatchObject({ body: "The host asked you to leave. You can come back in 8 minutes.", rejoin: "Rejoin in 8 min", nextChangeMs: 59_000 });
    expect(kickedCard(600_000, 590_000)).toMatchObject({ body: "The host asked you to leave. You can come back in 1 minute.", rejoin: "Rejoin in 1 min", nextChangeMs: 10_000 });
  });

  test("an unknown end (bounced off a cooldown another tab started): no countdown, a Try again key", () => {
    expect(kickedCard(null, 0)).toEqual({
      title: "You were removed from this room",
      body: "The host asked you to leave a little while ago. You can try again in a few minutes.",
      rejoin: "Try again",
      ready: true,
      nextChangeMs: null,
    });
  });

  test("after it: the wait is over and Rejoin is a plain key", () => {
    expect(kickedCard(600_000, 600_000)).toEqual({
      title: "You were removed from this room",
      body: "The wait is over. You can go back in if you like.",
      rejoin: "Rejoin",
      ready: true,
      nextChangeMs: null,
    });
  });
});
