import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import {
  ClientMessageSchema,
  ERROR_CODES,
  MAX_GENERIC_EMBED_URL_LENGTH,
  MAX_ROOM_MEMBERS,
  MAX_SERVER_MESSAGE_BYTES,
  MAX_URL_LENGTH,
  QUEUE_ADD_MEMBER_BURST,
  QUEUE_ADD_MEMBER_REFILL_MS,
  QUEUE_ADD_ROOM_BURST,
  QUEUE_ADD_ROOM_REFILL_MS,
  QUEUE_ENDED_DEBOUNCE_MS,
  QUEUE_ENDED_TOLERANCE_S,
  QUEUE_MAX,
  QueueItemIdSchema,
  QueueItemSchema,
  RoomStateSchema,
  ServerMessageSchema,
  parseClientMessage,
  parseServerMessage,
  type Member,
  type QueueItem,
  type RoomState,
} from "../src/index";

// Playback queue (OME-503, M6 C2, ADR 0031): queue-add/remove/advance, ended, queue in room state.

function rejects(schema: v.GenericSchema, input: unknown): void {
  expect(v.safeParse(schema, input).success).toBe(false);
}
function accepts(schema: v.GenericSchema, input: unknown): void {
  expect(v.safeParse(schema, input).success).toBe(true);
}

const SEATS = [null, null, null, null, null, null, null, null];
const alice: Member = { id: "m1", nickname: "Alice", avatar: 0 };
const YT = { provider: "youtube", videoId: "dQw4w9WgXcQ", url: "https://www.youtube.com/embed/dQw4w9WgXcQ" } as const;
const LIVE = { provider: "twitch", kind: "live", channel: "somechannel", url: "https://player.twitch.tv/?channel=somechannel" } as const;
const GENERIC = { provider: "generic", host: "player.example.com", url: "https://player.example.com/embed/42" } as const;
const PLAYBACK = { playing: true, position: 0, rate: 1, at: 1, rev: 1, action: "load", by: null } as const;
const item = (id: string, embed: QueueItem["embed"] = YT, by: string | null = "m1"): QueueItem => ({ id, embed, by });
const room = (extra: Partial<RoomState>): RoomState => ({ id: "lobby", seats: SEATS, members: [alice], embed: null, playback: null, ...extra });

describe("queue item id", () => {
  test.each(["q1", "a".repeat(32), "A-b_9"])("accepts %p", (id) => {
    accepts(QueueItemIdSchema, id);
  });
  test.each(["", "a".repeat(33), "q/1", "q 1", 1])("rejects %p", (id) => {
    rejects(QueueItemIdSchema, id);
  });
});

describe("client queue-add", () => {
  test("carries the raw url; the server canonicalizes it like a share", () => {
    expect(parseClientMessage('{"type":"queue-add","url":"https://youtu.be/dQw4w9WgXcQ"}')).toEqual({
      type: "queue-add",
      url: "https://youtu.be/dQw4w9WgXcQ",
    });
  });

  test("accepts a url up to MAX_URL_LENGTH", () => {
    const url = "https://a.example.com/" + "x".repeat(MAX_URL_LENGTH - 22);
    expect(parseClientMessage(JSON.stringify({ type: "queue-add", url }))).toEqual({ type: "queue-add", url });
  });

  test.each([
    ["missing url", { type: "queue-add" }],
    ["oversize url", { type: "queue-add", url: "https://a.example.com/" + "x".repeat(MAX_URL_LENGTH) }],
    ["number url", { type: "queue-add", url: 1 }],
    ["an embed instead of a url", { type: "queue-add", url: YT }],
    ["extra key", { type: "queue-add", url: "https://youtu.be/dQw4w9WgXcQ", embed: YT }],
  ])("rejects %s", (_name, input) => {
    rejects(ClientMessageSchema, input);
  });
});

describe("client queue-remove", () => {
  test("accepts an item id", () => {
    expect(parseClientMessage('{"type":"queue-remove","itemId":"q1"}')).toEqual({ type: "queue-remove", itemId: "q1" });
  });

  test.each([
    ["missing itemId", { type: "queue-remove" }],
    ["empty itemId", { type: "queue-remove", itemId: "" }],
    ["oversize itemId", { type: "queue-remove", itemId: "a".repeat(33) }],
    ["extra key", { type: "queue-remove", itemId: "q1", force: true }],
  ])("rejects %s", (_name, input) => {
    rejects(ClientMessageSchema, input);
  });
});

describe("client queue-advance", () => {
  test("names the item it skips", () => {
    expect(parseClientMessage('{"type":"queue-advance","fromItemId":"q1"}')).toEqual({ type: "queue-advance", fromItemId: "q1" });
  });

  test.each([
    ["missing fromItemId", { type: "queue-advance" }],
    ["null fromItemId", { type: "queue-advance", fromItemId: null }],
    ["bad fromItemId", { type: "queue-advance", fromItemId: "q 1" }],
    ["extra key", { type: "queue-advance", fromItemId: "q1", toItemId: "q2" }],
  ])("rejects %s", (_name, input) => {
    rejects(ClientMessageSchema, input);
  });
});

describe("client ended", () => {
  test("carries the item id and the player's position", () => {
    expect(parseClientMessage('{"type":"ended","itemId":"q1","position":212.5}')).toEqual({
      type: "ended",
      itemId: "q1",
      position: 212.5,
    });
  });

  test.each([
    ["missing itemId", { type: "ended", position: 1 }],
    ["missing position", { type: "ended", itemId: "q1" }],
    ["negative position", { type: "ended", itemId: "q1", position: -1 }],
    ["position past 12 h", { type: "ended", itemId: "q1", position: 12 * 3600 + 1 }],
    ["string position", { type: "ended", itemId: "q1", position: "1" }],
    ["extra key", { type: "ended", itemId: "q1", position: 1, duration: 2 }],
  ])("rejects %s", (_name, input) => {
    rejects(ClientMessageSchema, input);
  });

  test("NaN and Infinity never parse (JSON has no such numbers)", () => {
    expect(parseClientMessage('{"type":"ended","itemId":"q1","position":Infinity}')).toBeNull();
  });
});

describe("queue item", () => {
  test.each([
    ["synced", item("q1")],
    ["generic", item("q2", GENERIC)],
    ["live", item("q3", LIVE)],
    ["server-restored (no adder)", item("q4", YT, null)],
  ])("accepts a %s item", (_name, input) => {
    accepts(QueueItemSchema, input);
  });

  test.each([
    ["a raw url as embed", { id: "q1", embed: "https://youtu.be/dQw4w9WgXcQ", by: "m1" }],
    ["a non-canonical synced embed", { id: "q1", embed: { ...YT, url: "https://evil.example.com/" }, by: "m1" }],
    ["a non-canonical generic embed", { id: "q1", embed: { ...GENERIC, url: "javascript:alert(1)" }, by: "m1" }],
    ["a bad id", { id: "q 1", embed: YT, by: "m1" }],
    ["a bad adder", { id: "q1", embed: YT, by: "m/1" }],
    ["no adder key", { id: "q1", embed: YT }],
  ])("rejects %s", (_name, input) => {
    rejects(QueueItemSchema, input);
  });

  test("never carries the adder's nickname: the server strips it, clients look the member up", () => {
    const parsed = v.parse(QueueItemSchema, { ...item("q1"), nickname: "Alice" });
    expect(parsed).toEqual(item("q1"));
  });
});

describe("room state queue", () => {
  test("is absent from a pre-M6 server (read as empty, no current item)", () => {
    const parsed = v.parse(RoomStateSchema, room({}));
    expect(parsed.queue).toBeUndefined();
    expect(parsed.itemId).toBeUndefined();
  });

  test("holds up to QUEUE_MAX upcoming items and the current item's id", () => {
    const queue = Array.from({ length: QUEUE_MAX }, (_, i) => item(`q${String(i + 2)}`));
    accepts(RoomStateSchema, room({ embed: YT, playback: PLAYBACK, itemId: "q1", queue }));
  });

  test("a generic current item has no playback (click-to-load, ADR 0024)", () => {
    accepts(RoomStateSchema, room({ embed: GENERIC, playback: null, itemId: "q1", queue: [] }));
    rejects(RoomStateSchema, room({ embed: GENERIC, playback: PLAYBACK, itemId: "q1", queue: [] }));
  });

  test("an empty room can still have a queue waiting", () => {
    accepts(RoomStateSchema, room({ queue: [item("q1")] }));
  });

  test.each([
    ["more than QUEUE_MAX items", room({ queue: Array.from({ length: QUEUE_MAX + 1 }, (_, i) => item(`q${String(i)}`)) })],
    ["duplicate item ids", room({ queue: [item("q1"), item("q1")] })],
    ["a current item id without an embed", room({ itemId: "q1" })],
    ["the current item also queued", room({ embed: YT, playback: PLAYBACK, itemId: "q1", queue: [item("q1")] })],
    ["a bad current item id", room({ embed: YT, playback: PLAYBACK, itemId: "q 1" })],
  ])("rejects %s", (_name, input) => {
    rejects(RoomStateSchema, input);
  });
});

describe("server queue-changed", () => {
  test("broadcasts the whole upcoming queue and who changed it", () => {
    const frame = { type: "queue-changed", queue: [item("q2"), item("q3", GENERIC)], by: "m1" };
    expect(parseServerMessage(JSON.stringify(frame))).toEqual(frame);
  });

  test("by is null when the server advanced on its own (an ended report)", () => {
    accepts(ServerMessageSchema, { type: "queue-changed", queue: [], by: null });
  });

  test.each([
    ["missing queue", { type: "queue-changed", by: "m1" }],
    ["missing by", { type: "queue-changed", queue: [] }],
    ["too many items", { type: "queue-changed", queue: Array.from({ length: QUEUE_MAX + 1 }, (_, i) => item(`q${String(i)}`)), by: null }],
    ["duplicate ids", { type: "queue-changed", queue: [item("q1"), item("q1")], by: null }],
  ])("rejects %s", (_name, input) => {
    rejects(ServerMessageSchema, input);
  });
});

describe("server embed-changed itemId", () => {
  test("names the new current item", () => {
    const frame = { type: "embed-changed", embed: YT, by: null, playback: PLAYBACK, itemId: "q2" };
    expect(parseServerMessage(JSON.stringify(frame))).toEqual(frame);
  });

  test("a generic item becomes current without playback", () => {
    accepts(ServerMessageSchema, { type: "embed-changed", embed: GENERIC, by: null, playback: null, itemId: "q2" });
  });

  test("is optional (pre-M6 server)", () => {
    accepts(ServerMessageSchema, { type: "embed-changed", embed: YT, by: "m1", playback: PLAYBACK });
  });

  test.each([
    ["an item id with no embed", { type: "embed-changed", embed: null, by: null, playback: null, itemId: "q1" }],
    ["a bad item id", { type: "embed-changed", embed: YT, by: null, playback: PLAYBACK, itemId: "q/1" }],
  ])("rejects %s", (_name, input) => {
    rejects(ServerMessageSchema, input);
  });
});

describe("queue error codes", () => {
  test("queue_full and unsupported_url are new; rate_limited and control_owner_only are reused", () => {
    for (const code of ["queue_full", "unsupported_url", "rate_limited", "control_owner_only"]) {
      expect(ERROR_CODES).toContain(code as (typeof ERROR_CODES)[number]);
    }
    accepts(ServerMessageSchema, { type: "error", code: "queue_full", message: "The queue is full." });
  });
});

describe("queue limits (ADR 0031)", () => {
  test("values", () => {
    expect(QUEUE_MAX).toBe(20);
    expect(QUEUE_ADD_MEMBER_BURST).toBe(3);
    expect(QUEUE_ADD_MEMBER_REFILL_MS).toBe(10_000);
    expect(QUEUE_ADD_ROOM_BURST).toBe(10);
    expect(QUEUE_ADD_ROOM_REFILL_MS).toBe(3_000);
    expect(QUEUE_ENDED_DEBOUNCE_MS).toBe(3_000);
    expect(QUEUE_ENDED_TOLERANCE_S).toBe(5);
  });

  test("the room bucket admits more than one member's burst", () => {
    expect(QUEUE_ADD_ROOM_BURST).toBeGreaterThan(QUEUE_ADD_MEMBER_BURST);
  });
});

describe("frame size", () => {
  // Worst case: 25 members with 64-char ids, a generic current item and QUEUE_MAX generic items at the longest url.
  const longGeneric = () => {
    const url = "https://" + "a".repeat(60) + ".example.com/" + "x".repeat(MAX_GENERIC_EMBED_URL_LENGTH - 81);
    return { provider: "generic" as const, host: "a".repeat(60) + ".example.com", url };
  };
  const members = Array.from({ length: MAX_ROOM_MEMBERS }, (_, i) => ({
    id: `m${String(i).padStart(63, "0")}`,
    nickname: "W".repeat(20),
    avatar: 3,
    catching: true,
    muted: true,
  }));
  const queue = Array.from({ length: QUEUE_MAX }, (_, i) => item(`q${String(i).padStart(31, "0")}`, longGeneric(), members[i]?.id ?? null));

  test("the long generic url is valid and at the cap", () => {
    expect(longGeneric().url).toHaveLength(MAX_GENERIC_EMBED_URL_LENGTH);
    accepts(QueueItemSchema, queue[0]);
  });

  test("a worst-case snapshot with a full queue fits the client frame cap", () => {
    const state = {
      id: "a".repeat(32),
      seats: members.slice(0, 8).map((m) => m.id),
      members,
      embed: longGeneric(),
      playback: null,
      itemId: "c".repeat(32),
      queue,
      controlPolicy: "owner",
    };
    const raw = JSON.stringify({ type: "snapshot", self: members[0]?.id, room: state, shareToken: "a".repeat(22), owner: true });
    expect(new TextEncoder().encode(raw).length).toBeLessThan(MAX_SERVER_MESSAGE_BYTES);
    expect(parseServerMessage(raw)?.type).toBe("snapshot");
  });

  test("a full queue-changed frame parses", () => {
    const raw = JSON.stringify({ type: "queue-changed", queue, by: members[0]?.id });
    expect(parseServerMessage(raw)?.type).toBe("queue-changed");
  });
});
