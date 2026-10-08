import { describe, expect, test } from "bun:test";
import { MAX_ROOM_SECRETS, ROOM_SECRETS_STORAGE_KEY } from "@omega/shared";
import { forgetRoom, inviteLink, joinMessage, loadRoomSecrets, rememberRoom, secretFor, takeInviteKey } from "../src/room-secrets";

const OWNER = "o".repeat(21) + "A";
const KEY = "k".repeat(21) + "_";
const ROOM = "abcdefghijklmnopqrstuvwxyz";

class MemoryStore {
  readonly data = new Map<string, string>();
  failWrites = false;
  getItem(k: string): string | null {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, value: string): void {
    if (this.failWrites) throw new Error("QuotaExceededError");
    this.data.set(k, value);
  }
}

const stored = (s: MemoryStore): unknown => JSON.parse(s.getItem(ROOM_SECRETS_STORAGE_KEY) ?? "null");

describe("loadRoomSecrets: localStorage is untrusted, so it is Valibot-parsed", () => {
  test("nothing stored → no rooms", () => {
    expect(loadRoomSecrets(new MemoryStore())).toEqual({ v: 1, rooms: {} });
  });

  test("a valid record is read back", () => {
    const s = new MemoryStore();
    s.setItem(ROOM_SECRETS_STORAGE_KEY, JSON.stringify({ v: 1, rooms: { [ROOM]: { ownerToken: OWNER, inviteKey: KEY } } }));
    expect(loadRoomSecrets(s).rooms[ROOM]).toEqual({ ownerToken: OWNER, inviteKey: KEY });
  });

  test("bad JSON, a wrong version, a bad token or an extra key → no rooms, never a throw", () => {
    for (const raw of ["{", "null", JSON.stringify({ v: 2, rooms: {} }), JSON.stringify({ v: 1, rooms: { [ROOM]: { ownerToken: "short" } } }), JSON.stringify({ v: 1, rooms: { [ROOM]: { ownerToken: OWNER, extra: 1 } } }), JSON.stringify({ v: 1, rooms: { "Not An Id": {} } })]) {
      const s = new MemoryStore();
      s.setItem(ROOM_SECRETS_STORAGE_KEY, raw);
      expect(loadRoomSecrets(s)).toEqual({ v: 1, rooms: {} });
    }
  });

  test("a store that throws on read (storage disabled) → no rooms", () => {
    const throwing = {
      getItem(): string | null {
        throw new Error("SecurityError");
      },
    };
    expect(loadRoomSecrets(throwing)).toEqual({ v: 1, rooms: {} });
  });
});

describe("rememberRoom / forgetRoom", () => {
  test("saves the owner token and invite key under omega.rooms", () => {
    const s = new MemoryStore();
    expect(rememberRoom(s, ROOM, { ownerToken: OWNER, inviteKey: KEY })).toBe(true);
    expect(stored(s)).toEqual({ v: 1, rooms: { [ROOM]: { ownerToken: OWNER, inviteKey: KEY } } });
  });

  test("merges with what the room already has: an invite key never drops the owner token", () => {
    const s = new MemoryStore();
    rememberRoom(s, ROOM, { ownerToken: OWNER });
    rememberRoom(s, ROOM, { inviteKey: KEY });
    expect(loadRoomSecrets(s).rooms[ROOM]).toEqual({ ownerToken: OWNER, inviteKey: KEY });
  });

  test(`keeps at most MAX_ROOM_SECRETS (${String(MAX_ROOM_SECRETS)}) rooms, dropping the oldest first`, () => {
    const s = new MemoryStore();
    const id = (i: number): string => `room-${String(i)}`;
    for (let i = 0; i < MAX_ROOM_SECRETS + 3; i++) rememberRoom(s, id(i), { inviteKey: KEY });
    const ids = Object.keys(loadRoomSecrets(s).rooms);
    expect(ids).toHaveLength(MAX_ROOM_SECRETS);
    expect(ids).not.toContain(id(0));
    expect(ids).not.toContain(id(2));
    expect(ids).toContain(id(3));
    expect(ids).toContain(id(MAX_ROOM_SECRETS + 2));
  });

  test("touching a room makes it the newest, so it outlives rooms saved after it", () => {
    const s = new MemoryStore();
    for (let i = 0; i < MAX_ROOM_SECRETS; i++) rememberRoom(s, `room-${String(i)}`, { inviteKey: KEY });
    rememberRoom(s, "room-0", { ownerToken: OWNER });
    rememberRoom(s, "room-new", { inviteKey: KEY });
    const ids = Object.keys(loadRoomSecrets(s).rooms);
    expect(ids).toContain("room-0");
    expect(ids).not.toContain("room-1");
  });

  test("invite-only rooms are dropped before any room you own, however old it is (OME-458)", () => {
    const s = new MemoryStore();
    rememberRoom(s, ROOM, { ownerToken: OWNER });
    // 50 well-formed #k= links (each saved before the key is known to work) must not push the owner token out.
    for (let i = 0; i < MAX_ROOM_SECRETS + 5; i++) rememberRoom(s, `room-${String(i)}`, { inviteKey: KEY });
    const rooms = loadRoomSecrets(s).rooms;
    expect(Object.keys(rooms)).toHaveLength(MAX_ROOM_SECRETS);
    expect(rooms[ROOM]).toEqual({ ownerToken: OWNER });
    expect(Object.keys(rooms)).not.toContain("room-0");
    expect(Object.keys(rooms)).toContain(`room-${String(MAX_ROOM_SECRETS + 4)}`);
  });

  test("with only owned rooms left, the oldest owned room goes", () => {
    const s = new MemoryStore();
    for (let i = 0; i < MAX_ROOM_SECRETS + 1; i++) rememberRoom(s, `room-${String(i)}`, { ownerToken: OWNER });
    const ids = Object.keys(loadRoomSecrets(s).rooms);
    expect(ids).toHaveLength(MAX_ROOM_SECRETS);
    expect(ids).not.toContain("room-0");
    expect(ids).toContain(`room-${String(MAX_ROOM_SECRETS)}`);
  });

  test("a digit-only id (seeded rooms like /r/7) is never saved: it can't own a secret and would sort as the oldest", () => {
    const s = new MemoryStore();
    rememberRoom(s, ROOM, { inviteKey: KEY });
    expect(rememberRoom(s, "7", { inviteKey: KEY })).toBe(false);
    expect(Object.keys(loadRoomSecrets(s).rooms)).toEqual([ROOM]);
  });

  test("forgetRoom removes one room and keeps the rest", () => {
    const s = new MemoryStore();
    rememberRoom(s, ROOM, { ownerToken: OWNER });
    rememberRoom(s, "lobby", { inviteKey: KEY });
    forgetRoom(s, ROOM);
    expect(Object.keys(loadRoomSecrets(s).rooms)).toEqual(["lobby"]);
  });

  test("a full or disabled store reports false instead of throwing", () => {
    const s = new MemoryStore();
    s.failWrites = true;
    expect(rememberRoom(s, ROOM, { ownerToken: OWNER })).toBe(false);
    expect(forgetRoom(s, ROOM)).toBe(false);
  });
});

/** A fake `location` + `history` pair: replaceState rewrites the hash like the browser's does. */
function page(url: string) {
  const u = new URL(url);
  const calls: string[] = [];
  const loc = {
    get pathname() {
      return u.pathname;
    },
    get search() {
      return u.search;
    },
    get hash() {
      return u.hash;
    },
  };
  const history = {
    state: { kept: true } as unknown,
    replaceState(_data: unknown, _unused: string, next: string): void {
      calls.push(next);
      const n = new URL(next, u);
      u.pathname = n.pathname;
      u.search = n.search;
      u.hash = n.hash;
    },
  };
  return { loc, history, calls };
}

describe("takeInviteKey: the #k= fragment is read, saved and stripped at boot (ADR 0028)", () => {
  test("a valid key is saved for the room and the fragment is gone from the URL", () => {
    const s = new MemoryStore();
    const p = page(`https://omega.example/r/${ROOM}?x=1#k=${KEY}`);
    expect(takeInviteKey(p.loc, p.history, s, ROOM)).toBe(KEY);
    expect(p.calls).toEqual([`/r/${ROOM}?x=1`]);
    expect(p.loc.hash).toBe("");
    expect(loadRoomSecrets(s).rooms[ROOM]).toEqual({ inviteKey: KEY });
  });

  test("a malformed #k= is stripped too, and nothing is saved", () => {
    for (const hash of ["#k=short", `#k=${KEY}x`, `#k=${"k".repeat(21)}!`, "#k="]) {
      const s = new MemoryStore();
      const p = page(`https://omega.example/r/${ROOM}${hash}`);
      expect(takeInviteKey(p.loc, p.history, s, ROOM)).toBeNull();
      expect(p.loc.hash).toBe("");
      expect(s.getItem(ROOM_SECRETS_STORAGE_KEY)).toBeNull();
    }
  });

  test("no fragment, or one that isn't #k=, leaves the URL alone", () => {
    for (const url of [`https://omega.example/r/${ROOM}`, `https://omega.example/r/${ROOM}#top`]) {
      const p = page(url);
      expect(takeInviteKey(p.loc, p.history, new MemoryStore(), ROOM)).toBeNull();
      expect(p.calls).toEqual([]);
    }
  });

  test("off a room path (roomId null) the key is stripped but not saved", () => {
    const s = new MemoryStore();
    const p = page(`https://omega.example/#k=${KEY}`);
    expect(takeInviteKey(p.loc, p.history, s, null)).toBeNull();
    expect(p.loc.hash).toBe("");
    expect(s.getItem(ROOM_SECRETS_STORAGE_KEY)).toBeNull();
  });

  test("the key is stripped even when it can't be saved (storage full)", () => {
    const s = new MemoryStore();
    s.failWrites = true;
    const p = page(`https://omega.example/r/${ROOM}#k=${KEY}`);
    expect(takeInviteKey(p.loc, p.history, s, ROOM)).toBe(KEY);
    expect(p.loc.hash).toBe("");
  });
});

describe("secretFor: what the join uses", () => {
  test("the stored record, when there is no fresh key", () => {
    const s = new MemoryStore();
    rememberRoom(s, ROOM, { ownerToken: OWNER, inviteKey: KEY });
    expect(secretFor(loadRoomSecrets(s), ROOM, null)).toEqual({ ownerToken: OWNER, inviteKey: KEY });
    expect(secretFor(loadRoomSecrets(s), "lobby", null)).toBeUndefined();
  });

  test("the key just taken from the URL wins, even when storage couldn't keep it", () => {
    const s = new MemoryStore();
    s.failWrites = true;
    const p = page(`https://omega.example/r/${ROOM}#k=${KEY}`);
    const invited = takeInviteKey(p.loc, p.history, s, ROOM);
    expect(secretFor(loadRoomSecrets(s), ROOM, invited)).toEqual({ inviteKey: KEY });
  });
});

describe("inviteLink", () => {
  test("public room: the bare room URL", () => {
    expect(inviteLink("https://omega.example", ROOM)).toBe(`https://omega.example/r/${ROOM}`);
  });
  test("private room: the key goes in the fragment, never the path or query", () => {
    expect(inviteLink("https://omega.example", ROOM, KEY)).toBe(`https://omega.example/r/${ROOM}#k=${KEY}`);
  });
});

describe("joinMessage", () => {
  test("carries the stored owner token and invite key", () => {
    expect(joinMessage("zoe", 1, { ownerToken: OWNER, inviteKey: KEY })).toEqual({ type: "join", nickname: "zoe", avatar: 1, ownerToken: OWNER, inviteKey: KEY });
  });
  test("leaves absent secrets out entirely (join is a strictObject on the server)", () => {
    const m = joinMessage("zoe", 1, undefined);
    expect(m).toEqual({ type: "join", nickname: "zoe", avatar: 1 });
    expect("ownerToken" in m).toBe(false);
    expect("inviteKey" in m).toBe(false);
  });
});
