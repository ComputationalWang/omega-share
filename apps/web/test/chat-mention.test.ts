import { describe, expect, test } from "bun:test";
import type { Member } from "@omega/shared";
import { completeMention, mentionOptions, mentionQuery, mentions } from "../src/chat/mention";
import { logEntries } from "../src/chat/feed";
import { initialState, reduce } from "../src/state";

// OME-1531: a chat line that names me, as `@name` or as the bare name, is a mention. Client-only, nothing on the wire.

describe("mentions", () => {
  test("@name and the bare name as a whole word", () => {
    expect(mentions("hey @alice look", "alice")).toBe(true);
    expect(mentions("alice, look", "alice")).toBe(true);
    expect(mentions("look at this alice", "alice")).toBe(true);
    expect(mentions("look at this", "alice")).toBe(false);
  });

  test("case does not matter", () => {
    expect(mentions("HEY ALICE", "Alice")).toBe(true);
    expect(mentions("@aLiCe", "ALICE")).toBe(true);
  });

  test("accents and compatibility forms fold", () => {
    expect(mentions("hi zoe!", "Zoë")).toBe(true);
    expect(mentions("hi @Zoë", "zoe")).toBe(true);
    expect(mentions("ｂｏｂ?", "Bob")).toBe(true);
  });

  test("confusables fold: Cyrillic and Greek lookalikes, 0 for o, 1 for l", () => {
    expect(mentions("@аlісе hi", "alice")).toBe(true); // Cyrillic а, і, с, е
    expect(mentions("hi ΤΟΜ", "tom")).toBe(true); // Greek Τ, Ο
    expect(mentions("b0b", "Bob")).toBe(true);
    expect(mentions("a1ice", "alice")).toBe(true);
    expect(mentions("hi сосо", "coco")).toBe(true); // all Cyrillic
  });

  test("not inside another word", () => {
    expect(mentions("malice", "alice")).toBe(false);
    expect(mentions("alices", "alice")).toBe(false);
    expect(mentions("alice_x", "alice")).toBe(false);
    expect(mentions("bobby", "bob")).toBe(false);
    expect(mentions("2bob", "bob")).toBe(false);
    expect(mentions("mal @alice", "alice")).toBe(true);
  });

  test("a later whole-word hit counts after an inner one", () => {
    expect(mentions("malice and alice", "alice")).toBe(true);
  });

  test("names with spaces, dots and dashes", () => {
    expect(mentions("@cy twin come here", "Cy Twin")).toBe(true);
    expect(mentions("cy twins", "Cy Twin")).toBe(false);
    expect(mentions("hi j.d!", "J.D")).toBe(true);
  });

  test("an empty or blank name never matches", () => {
    expect(mentions("anything", "")).toBe(false);
    expect(mentions("anything", "  ")).toBe(false);
  });
});

describe("the log line", () => {
  const feedEntriesFor = (me: string, from: string, text: string) => {
    const members = [{ id: "a", nickname: me, avatar: 0 }, { id: "b", nickname: "bob", avatar: 0 }];
    const room = { id: "lobby", seats: [null, null, null, null, null, null, null, null], members, embed: null };
    const open = reduce(initialState, { type: "server", msg: { type: "snapshot", self: "a", room }, now: 0 });
    const e = { type: "server" as const, msg: { type: "chat" as const, memberId: from, text }, now: 0 };
    return logEntries(open, reduce(open, e), e);
  };

  test("others' lines that name me are mentions; mine never are", () => {
    expect(feedEntriesFor("alice", "b", "hi @alice")).toEqual([{ kind: "chat", nickname: "bob", text: "hi @alice", self: false, mention: true }]);
    expect(feedEntriesFor("alice", "b", "hi there")).toEqual([{ kind: "chat", nickname: "bob", text: "hi there", self: false, mention: false }]);
    expect(feedEntriesFor("alice", "a", "I am alice")).toEqual([{ kind: "chat", nickname: "alice", text: "I am alice", self: true, mention: false }]);
  });
});

describe("mentionQuery", () => {
  test("the @word the caret is in", () => {
    expect(mentionQuery("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionQuery("hi @al", 6)).toEqual({ start: 3, query: "al" });
    expect(mentionQuery("hi @al there", 6)).toEqual({ start: 3, query: "al" });
  });

  test("no @ before the caret's word, or an @ inside a word (an address): none", () => {
    expect(mentionQuery("hello", 5)).toBeNull();
    expect(mentionQuery("me@al", 5)).toBeNull();
    expect(mentionQuery("@al bob", 7)).toBeNull();
  });
});

describe("mentionOptions", () => {
  const m = (id: string, nickname: string): Member => ({ id, nickname, avatar: 0 });
  const members = [m("a", "alice"), m("b", "Bob"), m("c", "Zoë"), m("d", "Albert")];

  test("present members but me, folded prefix match, in room order", () => {
    expect(mentionOptions(members, "a", "")).toEqual(["Bob", "Zoë", "Albert"]);
    expect(mentionOptions(members, "b", "AL")).toEqual(["alice", "Albert"]);
    expect(mentionOptions(members, "a", "zo")).toEqual(["Zoë"]);
    expect(mentionOptions(members, "a", "x")).toEqual([]);
  });
});

describe("completeMention", () => {
  test("replaces the @query with @name and one space, caret after it", () => {
    expect(completeMention("hi @al there", { start: 3, query: "al" }, "alice")).toEqual({ value: "hi @alice there", caret: 10 });
    expect(completeMention("@", { start: 0, query: "" }, "Bob")).toEqual({ value: "@Bob ", caret: 5 });
  });
});
