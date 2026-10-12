import { describe, expect, test } from "bun:test";
import type { Member, MemberId, RoomState, ServerMessage } from "@omega/shared";
import { logEntries } from "../src/chat/feed";
import { avatarAlphaFor, DIMMED_ALPHA } from "../src/room-view";
import { initialState, reduce, type ViewEvent, type ViewState } from "../src/state";
import { standingPlacement } from "../src/walk/standing";

// OME-911 (ADR 0043, "Position and presence"): away members stay put and dimmed; standing slots are stable.

const ada: Member = { id: "a", nickname: "Ada", avatar: 0 };
const kit: Member = { id: "k", nickname: "Kit", avatar: 1 };
const room = (): RoomState => ({ id: "lobby", seats: [null, null], members: [ada, kit], embed: null });
const msg = (m: ServerMessage): ViewEvent => ({ type: "server", msg: m, now: 1 });
const joined = (): ViewState => reduce(initialState, { type: "server", msg: { type: "snapshot", self: "a", room: room() }, now: 0 });
const presence = (s: ViewState, memberId: string, away: boolean): ViewState => reduce(s, msg({ type: "member-presence", memberId, away }));
const awayOf = (s: ViewState, id: string): boolean | undefined => s.room?.members.find((m) => m.id === id)?.away;

describe("member-presence reducer", () => {
  test("away on and off lands on that member only", () => {
    const on = presence(joined(), "k", true);
    expect(awayOf(on, "k")).toBe(true);
    expect(awayOf(on, "a")).toBeUndefined();
    expect(awayOf(presence(on, "k", false), "k")).toBe(false);
  });

  test("an unknown member or an unchanged value returns the same state", () => {
    const s = joined();
    expect(presence(s, "nobody", true)).toBe(s);
    expect(presence(s, "k", false)).toBe(s);
    const on = presence(s, "k", true);
    expect(presence(on, "k", true)).toBe(on);
  });

  test("seats and other member objects are kept", () => {
    const s = joined();
    const on = presence(s, "k", true);
    expect(on.room?.seats).toBe(s.room?.seats);
    expect(on.room?.members[0]).toBe(s.room?.members[0]);
  });
});

describe("chat log for presence and resume", () => {
  const entries = (s: ViewState, e: ViewEvent): unknown => logEntries(s, reduce(s, e), e);

  test("member-presence logs nothing, away or back", () => {
    const s = joined();
    expect(entries(s, msg({ type: "member-presence", memberId: "k", away: true }))).toEqual([]);
    expect(entries(presence(s, "k", true), msg({ type: "member-presence", memberId: "k", away: false }))).toEqual([]);
  });

  test("a resumed snapshot logs nothing and leaves no system line", () => {
    const e = msg({ type: "snapshot", self: "a", room: room(), resumed: true });
    expect(entries(joined(), e)).toEqual([]);
    expect(reduce(joined(), e).syslines).toEqual([]);
  });
});

describe("standingPlacement", () => {
  const m = (id: string, standingSlot?: number): { id: string; standingSlot?: number } => (standingSlot === undefined ? { id } : { id, standingSlot });
  const spots = (x: ReadonlyMap<MemberId, number>): Record<string, number> => Object.fromEntries(x);

  test("a slotted member stands exactly on their slot", () => {
    expect(spots(standingPlacement([m("a", 5), m("b", 2)], new Set([5, 2]), 12, new Map()))).toEqual({ a: 5, b: 2 });
  });

  test("a slot beyond the available points gets no spot, and no fallback", () => {
    expect(spots(standingPlacement([m("a", 9), m("b", 1)], new Set([9, 1]), 4, new Map()))).toEqual({ b: 1 });
  });

  test("legacy members avoid points claimed by slotted members, including seated ones", () => {
    expect(spots(standingPlacement([m("a", 0), m("l1"), m("l2")], new Set([0, 1]), 12, new Map()))).toEqual({ a: 0, l1: 2, l2: 3 });
  });

  test("legacy members keep their previous spot unless a slot claims it", () => {
    const prev = new Map<MemberId, number>([["l1", 3], ["l2", 4]]);
    expect(spots(standingPlacement([m("l1"), m("l2")], new Set([3]), 12, prev))).toEqual({ l1: 0, l2: 4 });
  });
});

describe("avatarAlphaFor", () => {
  test("away dims independent of hidden; hidden stays the dimmest", () => {
    expect(avatarAlphaFor(false, false)).toBe(1);
    expect(avatarAlphaFor(false, true)).toBeLessThan(1);
    expect(avatarAlphaFor(false, true)).toBeGreaterThan(DIMMED_ALPHA);
    expect(avatarAlphaFor(true, false)).toBe(DIMMED_ALPHA);
    expect(avatarAlphaFor(true, true)).toBe(DIMMED_ALPHA);
  });
});
