import { describe, expect, test } from "bun:test";
import type { Member, RoomState } from "@omega/shared";
import { slashCommand } from "../src/chat/effects";
import { hugStep, matchMember } from "../src/chat/hug";
import { initialState, reduce, type ViewState } from "../src/state";

// OME-1453: /hug and /highfive walk me over to someone, then send the existing emote on arrival.

const m = (id: string, nickname: string): Member => ({ id, nickname, avatar: 0 });

describe("slashCommand /hug and /highfive", () => {
  test("/hug <name> is a heart for that name, /highfive <name> a clap; the name keeps its case", () => {
    expect(slashCommand("/hug Bob")).toEqual({ type: "hug", kind: "heart", name: "Bob" });
    expect(slashCommand("  /HIGHFIVE  Cy Twin ")).toEqual({ type: "hug", kind: "clap", name: "Cy Twin" });
  });

  test("without a name it's the usage hint", () => {
    expect(slashCommand("/hug")).toEqual({ type: "hug-usage" });
    expect(slashCommand("/highfive   ")).toEqual({ type: "hug-usage" });
  });

  test("/hugs and /highfives are chat", () => {
    expect(slashCommand("/hugs bob")).toBeNull();
    expect(slashCommand("/highfives bob")).toBeNull();
  });
});

describe("matchMember", () => {
  const members = [m("a", "alice"), m("b", "Bob"), m("c", "Zoë")];

  test("matches a present member case-insensitively", () => {
    expect(matchMember(members, "a", "BOB")).toEqual({ type: "match", id: "b", nickname: "Bob" });
  });

  test("accents and compatibility forms fold: zoe finds Zoë, a fullwidth ｂｏｂ finds Bob", () => {
    expect(matchMember(members, "a", "zoe")).toEqual({ type: "match", id: "c", nickname: "Zoë" });
    expect(matchMember(members, "a", "ｂｏｂ")).toEqual({ type: "match", id: "b", nickname: "Bob" });
  });

  test("nobody by that name, or only me: none", () => {
    expect(matchMember(members, "a", "dave")).toEqual({ type: "none" });
    expect(matchMember(members, "a", "Alice")).toEqual({ type: "none" });
  });

  test("two members folding to the same name: ambiguous", () => {
    expect(matchMember([...members, m("d", "zoe")], "a", "ZOE")).toEqual({ type: "ambiguous" });
  });
});

describe("hugStep", () => {
  const room: RoomState = { id: "lobby", seats: [null, null, null, null, null, null, null, null], members: [m("a", "alice"), m("b", "bob")], embed: null };
  const open: ViewState = reduce(initialState, { type: "server", msg: { type: "snapshot", self: "a", room }, now: 0 });
  const walked = (s: ViewState, id: string, x: number, y: number): ViewState => reduce(s, { type: "server", msg: { type: "walked", memberId: id, cell: { x, y } }, now: 0 });
  const start = walked(walked(open, "a", 9, 9), "b", 6, 9);
  const hug = { target: "b", cell: { x: 7, y: 9 } };

  test("my walked to the cell beside them: arrived", () => {
    expect(hugStep(start, walked(start, "a", 7, 9), hug)).toBe("arrived");
  });

  test("anything else that leaves me where I was: nothing yet", () => {
    expect(hugStep(start, walked(start, "b", 6, 8), hug)).toBeNull();
    expect(hugStep(start, start, hug)).toBeNull();
  });

  test("I walked somewhere else (clicked elsewhere): cancel", () => {
    expect(hugStep(start, walked(start, "a", 2, 2), hug)).toBe("cancel");
  });

  // A /hug from a seat: the walk stands me up first, so being seated already isn't sitting down.
  const sat = (st: ViewState, id: string, seat: number): ViewState => (st.room === null ? st : { ...st, room: { ...st.room, seats: st.room.seats.map((x, i) => (i === seat ? id : x)) } });

  test("I sat down: cancel; already seated when it started: not yet", () => {
    expect(hugStep(start, sat(start, "a", 2), hug)).toBe("cancel");
    const seated = sat(start, "a", 2);
    expect(hugStep(seated, walked(seated, "b", 6, 8), hug)).toBeNull();
  });

  test("they left, or the room closed: cancel", () => {
    const gone = reduce(start, { type: "server", msg: { type: "member-left", memberId: "b" }, now: 0 });
    expect(hugStep(start, gone, hug)).toBe("cancel");
    expect(hugStep(start, { ...start, status: "closed" }, hug)).toBe("cancel");
  });
});
