import { describe, expect, test } from "bun:test";
import { MAX_POSITION_S, WALK_REFILL_MS, type PlaybackState, type RoomLayout, type RoomState } from "@omega/shared";
import { chatIntent, createWalkGate, floorSitIntent, lieIntent, playerIntent, seatViews, seekIntent, sitIntent, DOUBLE_TAP_MS, doubleTap, stepAllowed, stepCell, togglePlayIntent, walkIntent, walkOverIntent, type PlaybackTarget } from "../src/intents";
import { TILE_MS } from "../src/walk/walks";
import { initialState, reduce, type ViewState } from "../src/state";

const seats = ["b", null, "a", null, null, null, null, null];
const room: RoomState = {
  id: "lobby",
  seats,
  members: [
    { id: "a", nickname: "alice", avatar: 0 },
    { id: "b", nickname: "bob", avatar: 3 },
  ],
  embed: null,
};
const open: ViewState = reduce(initialState, { type: "server", msg: { type: "snapshot", self: "a", room }, now: 0 });

// OME-1501: /sit, "Sit here" and S toggle sitting on the floor of my cell; with no cell there's nothing to sit on.
describe("floorSitIntent", () => {
  const withMe = (patch: object): ViewState => reduce(open, { type: "server", msg: { type: "snapshot", self: "a", room: { ...room, seats: [null, null, null, null, null, null, null, null], members: [{ id: "a", nickname: "alice", avatar: 0, ...patch }] } }, now: 0 });
  test("standing on a cell sits me down; sitting there gets me up", () => {
    expect(floorSitIntent(withMe({ cell: { x: 3, y: 8 } }))).toEqual({ type: "floor-sit", on: true });
    expect(floorSitIntent(withMe({ cell: { x: 3, y: 8 }, floorSit: true }))).toEqual({ type: "floor-sit", on: false });
  });
  test("no cell (a seat or a standing spot) is \"no-cell\"", () => {
    expect(floorSitIntent(open)).toBe("no-cell");
    expect(floorSitIntent(withMe({}))).toBe("no-cell");
  });
  test("nothing while not connected", () => {
    expect(floorSitIntent(reduce(withMe({ cell: { x: 3, y: 8 } }), { type: "disconnected" }))).toBeNull();
  });
});

describe("sitIntent", () => {
  test("a free seat sends sit", () => {
    expect(sitIntent(open, 1)).toEqual({ type: "sit", seat: 1 });
  });
  test("my own seat stands me up", () => {
    expect(sitIntent(open, 2)).toEqual({ type: "sit", seat: null });
  });
  test("someone else's seat does nothing", () => {
    expect(sitIntent(open, 0)).toBeNull();
  });
  test("nothing is sent while not connected", () => {
    expect(sitIntent(reduce(open, { type: "disconnected" }), 1)).toBeNull();
  });
  test("out-of-range seats do nothing", () => {
    expect(sitIntent(open, 8)).toBeNull();
    expect(sitIntent(open, -1)).toBeNull();
  });
});

describe("chatIntent", () => {
  test("valid text is trimmed into a chat message", () => {
    expect(chatIntent("  hello  ")).toEqual({ type: "chat", text: "hello" });
  });
  test("empty, invisible and oversized text is rejected", () => {
    expect(chatIntent("   ")).toBeNull();
    expect(chatIntent("\u200B")).toBeNull();
    expect(chatIntent("x".repeat(281))).toBeNull();
  });
});

describe("seatViews", () => {
  test("lists all 8 seats with occupant and whether it's me", () => {
    const views = seatViews(open);
    expect(views).toHaveLength(8);
    expect(views[0]).toEqual({ index: 0, member: { id: "b", nickname: "bob", avatar: 3 }, isSelf: false });
    expect(views[1]).toEqual({ index: 1, member: null, isSelf: false });
    expect(views[2]?.isSelf).toBe(true);
  });
  test("with no room, all seats are empty", () => {
    expect(seatViews(initialState).every((v) => v.member === null)).toBe(true);
  });
});

const embed = { provider: "youtube", videoId: "dQw4w9WgXcQ", url: "https://www.youtube.com/embed/dQw4w9WgXcQ" } as const;
const playingAt10: PlaybackState = { playing: true, position: 10, rate: 1, at: 1_000_000, rev: 3, action: "play", by: "b" };
const pausedAt10: PlaybackState = { ...playingAt10, playing: false, action: "pause" };
const target = (playback: PlaybackState | null): PlaybackTarget => ({ embed, playback });

describe("togglePlayIntent (shared play/pause key → control)", () => {
  test("paused room: play from where it stopped", () => {
    expect(togglePlayIntent(target(pausedAt10), 1_005_000)).toEqual({ type: "control", url: "https://www.youtube.com/embed/dQw4w9WgXcQ", playing: true, position: 10 });
  });
  test("playing room: pause at the room's position now, from the server clock", () => {
    expect(togglePlayIntent(target(playingAt10), 1_002_500)).toEqual({ type: "control", url: "https://www.youtube.com/embed/dQw4w9WgXcQ", playing: false, position: 12.5 });
  });
  test("no embed or no playback yet: nothing to control", () => {
    expect(togglePlayIntent({ embed: null, playback: null }, 0)).toBeNull();
    expect(togglePlayIntent(target(null), 0)).toBeNull();
    expect(togglePlayIntent({ embed }, 0)).toBeNull();
  });
  test("the position stays within the wire range", () => {
    const far: PlaybackState = { ...playingAt10, position: MAX_POSITION_S - 1 };
    expect(togglePlayIntent(target(far), 1_000_000 + 10_000)).toMatchObject({ position: MAX_POSITION_S });
  });
});

describe("seekIntent (shared seek bar → control)", () => {
  test("keeps the room playing or paused, moves the position", () => {
    expect(seekIntent(target(playingAt10), 750)).toEqual({ type: "control", url: "https://www.youtube.com/embed/dQw4w9WgXcQ", playing: true, position: 750 });
    expect(seekIntent(target(pausedAt10), 3)).toEqual({ type: "control", url: "https://www.youtube.com/embed/dQw4w9WgXcQ", playing: false, position: 3 });
  });
  test("clamps to 0 … MAX_POSITION_S and rejects non-numbers", () => {
    expect(seekIntent(target(playingAt10), -5)).toMatchObject({ position: 0 });
    expect(seekIntent(target(playingAt10), MAX_POSITION_S + 9)).toMatchObject({ position: MAX_POSITION_S });
    expect(seekIntent(target(playingAt10), Number.NaN)).toBeNull();
  });
  test("no playback: null", () => {
    expect(seekIntent(target(null), 5)).toBeNull();
  });
});

describe("playerIntent (a click inside the player → control)", () => {
  test("passes the player's play/pause and position through", () => {
    expect(playerIntent(target(playingAt10), false, 42.5)).toEqual({ type: "control", url: "https://www.youtube.com/embed/dQw4w9WgXcQ", playing: false, position: 42.5 });
  });
  test("no embed: null", () => {
    expect(playerIntent({ embed: null, playback: null }, true, 1)).toBeNull();
  });
});

// Free walking (OME-1350, ADR 0053) on the default layout: (0,0) is the TV, (5,1) a chair, (3,8) open floor.
describe("walkIntent", () => {
  test("a free floor cell sends walk", () => {
    expect(walkIntent(open, { x: 3, y: 8 })).toEqual({ type: "walk", cell: { x: 3, y: 8 } });
  });
  test("a cell under a solid piece is blocked, and nothing is sent", () => {
    expect(walkIntent(open, { x: 0, y: 0 })).toBe("blocked");
    expect(walkIntent(open, { x: 5, y: 1 })).toBe("blocked");
  });
  test("the cell I already stand on does nothing", () => {
    const here = reduce(open, { type: "server", msg: { type: "walked", memberId: "a", cell: { x: 3, y: 8 } }, now: 0 });
    expect(walkIntent(here, { x: 3, y: 8 })).toBeNull();
  });
  test("a jog sends walk with run, even to the cell I'm already headed for (OME-1464)", () => {
    expect(walkIntent(open, { x: 3, y: 8 }, true)).toEqual({ type: "walk", cell: { x: 3, y: 8 }, run: true });
    const here = reduce(open, { type: "server", msg: { type: "walked", memberId: "a", cell: { x: 3, y: 8 } }, now: 0 });
    expect(walkIntent(here, { x: 3, y: 8 }, true)).toEqual({ type: "walk", cell: { x: 3, y: 8 }, run: true });
    expect(walkIntent(open, { x: 0, y: 0 }, true)).toBe("blocked");
  });
  test("nothing is sent while not connected", () => {
    expect(walkIntent(reduce(open, { type: "disconnected" }), { x: 3, y: 8 })).toBeNull();
  });
});

describe("doubleTap (OME-1464)", () => {
  test("a second click or tap on the same cell within DOUBLE_TAP_MS is a double", () => {
    const first = { cell: { x: 3, y: 8 }, at: 1000 };
    expect(doubleTap(null, { x: 3, y: 8 }, 1000)).toBe(false);
    expect(doubleTap(first, { x: 3, y: 8 }, 1000 + DOUBLE_TAP_MS)).toBe(true);
    expect(doubleTap(first, { x: 3, y: 8 }, 1000 + DOUBLE_TAP_MS + 1)).toBe(false);
    expect(doubleTap(first, { x: 4, y: 8 }, 1100)).toBe(false);
  });
});

describe("stepCell", () => {
  test("Right/Left walk the column, Down/Up the row", () => {
    expect(stepCell({ x: 4, y: 4 }, "ArrowRight")).toEqual({ x: 5, y: 4 });
    expect(stepCell({ x: 4, y: 4 }, "ArrowLeft")).toEqual({ x: 3, y: 4 });
    expect(stepCell({ x: 4, y: 4 }, "ArrowDown")).toEqual({ x: 4, y: 5 });
    expect(stepCell({ x: 4, y: 4 }, "ArrowUp")).toEqual({ x: 4, y: 3 });
  });
  test("off the floor is no step", () => {
    expect(stepCell({ x: 0, y: 4 }, "ArrowLeft")).toBeNull();
    expect(stepCell({ x: 4, y: 9 }, "ArrowDown")).toBeNull();
  });
});

describe("stepAllowed", () => {
  test("a fresh key press always steps", () => {
    expect(stepAllowed(false, 100, 50)).toBe(true);
  });
  test("a held Shift+arrow jogs, so it repeats at most once a jog tile (OME-1464)", () => {
    expect(stepAllowed(true, 1000 + TILE_MS / 2 - 1, 1000, true)).toBe(false);
    expect(stepAllowed(true, 1000 + TILE_MS / 2, 1000, true)).toBe(true);
  });
  test("a held key repeats at most once a tile (the walk rate)", () => {
    expect(stepAllowed(true, 1000 + TILE_MS - 1, 1000)).toBe(false);
    expect(stepAllowed(true, 1000 + TILE_MS, 1000)).toBe(true);
  });
});

describe("createWalkGate", () => {
  function gate() {
    let now = 0;
    const timers: { at: number; fn: () => void }[] = [];
    const sent: number[] = [];
    const g = createWalkGate({
      now: () => now,
      send: (m) => {
        if (m.type === "walk") sent.push(m.cell.x);
      },
      setTimer: (fn, ms) => {
        timers.push({ at: now + ms, fn });
      },
    });
    const walk = (x: number) => ({ type: "walk", cell: { x, y: 0 } }) as const;
    const advance = (ms: number) => {
      now += ms;
      for (let t = timers[0]; t !== undefined && t.at <= now; t = timers[0]) {
        timers.shift();
        t.fn();
      }
    };
    return { g, walk, advance, sent, timers };
  }
  test("a lone click sends at once", () => {
    const { g, walk, sent } = gate();
    g.push(walk(1));
    expect(sent).toEqual([1]);
  });
  test("a click burst sends at most one walk per WALK_REFILL_MS, and the last click always lands", () => {
    const { g, walk, advance, sent } = gate();
    // 60 clicks at ~15/s for 4 s, as in QA OME-1353.
    for (let i = 0; i < 60; i++) {
      g.push(walk(i));
      advance(66);
    }
    advance(WALK_REFILL_MS);
    expect(sent.length).toBeLessThanOrEqual(Math.ceil((60 * 66) / WALK_REFILL_MS) + 1);
    expect(sent.at(-1)).toBe(59);
  });
  test("clicks inside one window coalesce to the latest target, one timer", () => {
    const { g, walk, advance, sent, timers } = gate();
    g.push(walk(1));
    g.push(walk(2));
    g.push(walk(3));
    expect(timers.length).toBe(1);
    advance(WALK_REFILL_MS);
    expect(sent).toEqual([1, 3]);
  });
  test("cancel drops the held walk, so a seat click after a burst wins (QA OME-1372)", () => {
    const { g, walk, advance, sent } = gate();
    g.push(walk(1));
    g.push(walk(2));
    g.cancel();
    advance(WALK_REFILL_MS);
    expect(sent).toEqual([1]);
  });
});

// OME-1376: Walk over (the member menu, the People list): walk to the free cell beside them nearest me.
describe("walkOverIntent", () => {
  const standing = (s: ViewState, id: string, x: number, y: number): ViewState => reduce(s, { type: "server", msg: { type: "walked", memberId: id, cell: { x, y } }, now: 0 });
  const nowhere = (): null => null;

  test("sends walk to their side nearest me", () => {
    const s = standing(standing(open, "a", 9, 9), "b", 6, 9);
    expect(walkOverIntent(s, "b", nowhere)).toEqual({ type: "walk", cell: { x: 7, y: 9 } });
  });

  test("a seated member's cell comes from the stage", () => {
    const s = standing(open, "a", 9, 9);
    const msg = walkOverIntent(s, "b", (id) => (id === "b" ? { x: 6, y: 9 } : null));
    expect(msg).toEqual({ type: "walk", cell: { x: 7, y: 9 } });
  });

  test("a side someone else stands on is not picked", () => {
    const three: ViewState = { ...open, room: open.room === null ? null : { ...open.room, members: [...open.room.members, { id: "c", nickname: "cy", avatar: 1 }] } };
    const s = standing(standing(standing(three, "a", 9, 9), "b", 6, 9), "c", 7, 9);
    const msg = walkOverIntent(s, "b", nowhere);
    expect(msg).not.toBeNull();
    expect(msg).not.toEqual({ type: "walk", cell: { x: 7, y: 9 } });
  });

  test("null when I'm already beside them, they're nowhere, or I'm not connected", () => {
    expect(walkOverIntent(standing(standing(open, "a", 7, 9), "b", 6, 9), "b", nowhere)).toBeNull();
    expect(walkOverIntent(standing(open, "a", 9, 9), "b", nowhere)).toBeNull();
    expect(walkOverIntent(reduce(standing(standing(open, "a", 9, 9), "b", 6, 9), { type: "disconnected" }), "b", nowhere)).toBeNull();
  });
});

// OME-1691: a lie key on a sofa, couch or cat bed lies me down on it, or gets me up from it.
describe("lieIntent", () => {
  const layout: RoomLayout = { furniture: [{ kind: "sofa", col: 2, row: 5, facing: "ne" }, { kind: "lamp", col: 9, row: 0, facing: "se" }, { kind: "cat", col: 9, row: 9, facing: "sw" }] };
  const me = { id: "a", nickname: "alice", avatar: 0 } as const;
  const bob = { id: "b", nickname: "bob", avatar: 3 } as const;
  const inRoom = (members: RoomState["members"], connected = true, seats: RoomState["seats"] = [null, null, null, null, null, null, null, null]): ViewState => {
    const s = reduce(initialState, { type: "server", msg: { type: "snapshot", self: "a", room: { ...room, seats, members, layout } }, now: 0 });
    return connected ? s : reduce(s, { type: "disconnected" });
  };

  test("a free sofa or cat bed: lie down on it", () => {
    expect(lieIntent(inRoom([me]), 0)).toEqual({ type: "lie", piece: 0 });
    expect(lieIntent(inRoom([me]), 2)).toEqual({ type: "lie", piece: 2 });
  });

  test("the piece I lie on: get up", () => {
    expect(lieIntent(inRoom([{ ...me, lying: 0 }]), 0)).toEqual({ type: "lie", piece: null });
  });

  test("lying on another piece, I move to this one", () => {
    expect(lieIntent(inRoom([{ ...me, lying: 0 }]), 2)).toEqual({ type: "lie", piece: 2 });
  });

  test("null for a piece someone else lies on, one with no lie style, one that isn't there, and when I'm not connected", () => {
    expect(lieIntent(inRoom([me, { ...bob, lying: 0 }]), 0)).toBeNull();
    expect(lieIntent(inRoom([me]), 1)).toBeNull();
    expect(lieIntent(inRoom([me]), 3)).toBeNull();
    expect(lieIntent(inRoom([me]), -1)).toBeNull();
    expect(lieIntent(inRoom([me], false), 0)).toBeNull();
  });

  // QA OME-1785 §2: the server treats a lain-on piece's seats as taken (and a sitter blocks lying), so the keys say so.
  test("null while someone else sits on one of the piece's seats; my own seat there doesn't block me", () => {
    expect(lieIntent(inRoom([me, bob], true, ["b", null, null, null, null, null, null, null]), 0)).toBeNull();
    expect(lieIntent(inRoom([me, bob], true, [null, "b", null, null, null, null, null, null]), 0)).toBeNull();
    expect(lieIntent(inRoom([me, bob], true, ["a", null, "b", null, null, null, null, null]), 0)).toEqual({ type: "lie", piece: 0 });
  });

  test("seats on a piece someone else lies on show them and can't be sat on; mine stay free for me", () => {
    const bobLies = inRoom([me, { ...bob, lying: 0 }]);
    expect(seatViews(bobLies).slice(0, 3).map((v) => v.member?.id ?? null)).toEqual(["b", "b", null]);
    expect(seatViews(bobLies)[0]?.isSelf).toBe(false);
    expect(sitIntent(bobLies, 0)).toBeNull();
    expect(sitIntent(bobLies, 1)).toBeNull();
    expect(sitIntent(bobLies, 2)).toEqual({ type: "sit", seat: 2 });
    const iLie = inRoom([{ ...me, lying: 0 }, bob]);
    expect(seatViews(iLie)[0]?.member).toBeNull();
    expect(sitIntent(iLie, 0)).toEqual({ type: "sit", seat: 0 });
  });
});
