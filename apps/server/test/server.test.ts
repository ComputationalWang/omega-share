import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as v from "valibot";
import { MAX_ROOM_MEMBERS, RoomListResponseSchema, ShareResponseSchema } from "@omega/shared";
import { Client, EXTENSION_ORIGIN, SITE_ORIGIN, start, type TestServer } from "./helpers";

const WATCH_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const CANONICAL = { provider: "youtube", videoId: "dQw4w9WgXcQ", url: "https://www.youtube.com/embed/dQw4w9WgXcQ" } as const;

let t: TestServer;
const clients: Client[] = [];
async function join(nickname: string, avatar = 0) {
  const r = await Client.join(t.ws(), nickname, avatar);
  clients.push(r.client);
  return r;
}
async function open(url = t.ws(), origin?: string) {
  const c = await Client.open(url, origin);
  clients.push(c);
  return c;
}

beforeEach(() => {
  t = start();
});
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await t.server.stop(true);
});

function share(body: string, init: { roomId?: string; origin?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init.origin !== undefined) headers["origin"] = init.origin;
  return fetch(`${t.http}/rooms/${init.roomId ?? "lobby"}/share`, { method: "POST", headers, body });
}
async function shareJson(res: Response) {
  return v.parse(ShareResponseSchema, await res.json());
}

describe("POST /rooms/:id/share", () => {
  test("canonicalizes the URL, sets the embed and broadcasts embed-changed", async () => {
    const { client } = await join("alice");
    const res = await share(JSON.stringify({ url: WATCH_URL }), { origin: EXTENSION_ORIGIN });
    expect(res.status).toBe(200);
    expect(await shareJson(res)).toEqual({ ok: true, embed: CANONICAL });
    expect(await client.next("embed-changed")).toEqual({ type: "embed-changed", embed: CANONICAL, by: null });

    const { snapshot } = await join("bob");
    expect(snapshot.room.embed).toEqual(CANONICAL);
  });

  test("rejects a URL off the provider allowlist with 400 and no broadcast", async () => {
    const { client } = await join("alice");
    for (const url of ["https://evil.example/watch?v=dQw4w9WgXcQ", "javascript:alert(1)", "https://vimeo.com/1"]) {
      const res = await share(JSON.stringify({ url }));
      expect(res.status).toBe(400);
      const body = await shareJson(res);
      expect(body.ok ? null : body.error.code).toBe("unsupported_url");
    }
    await client.none("embed-changed");
  });

  test("rejects malformed bodies with 400 invalid_body", async () => {
    for (const body of ["not json", "{}", JSON.stringify({ url: WATCH_URL, extra: 1 }), JSON.stringify({ url: 5 })]) {
      const res = await share(body);
      expect(res.status).toBe(400);
      const json = await shareJson(res);
      expect(json.ok ? null : json.error.code).toBe("invalid_body");
    }
  });

  test("rejects an oversized body with 413", async () => {
    const res = await share(JSON.stringify({ url: "https://www.youtube.com/watch?v=" + "a".repeat(20_000) }));
    expect(res.status).toBe(413);
    const json = await shareJson(res);
    expect(json.ok ? null : json.error.code).toBe("payload_too_large");
  });

  test("unknown room is 404 room_not_found", async () => {
    const res = await share(JSON.stringify({ url: WATCH_URL }), { roomId: "nope" });
    expect(res.status).toBe(404);
    const json = await shareJson(res);
    expect(json.ok ? null : json.error.code).toBe("room_not_found");
  });

  test("a request from a foreign origin is refused with 403", async () => {
    const { client } = await join("alice");
    const res = await share(JSON.stringify({ url: WATCH_URL }), { origin: "https://evil.example" });
    expect(res.status).toBe(403);
    await client.none("embed-changed");
  });
});

describe("CORS", () => {
  const preflight = (origin: string) =>
    fetch(`${t.http}/rooms/lobby/share`, {
      method: "OPTIONS",
      headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
    });

  test("allows the extension and the site origin", async () => {
    for (const origin of [EXTENSION_ORIGIN, SITE_ORIGIN]) {
      const res = await preflight(origin);
      expect(res.headers.get("access-control-allow-origin")).toBe(origin);
      expect(res.headers.get("access-control-allow-methods") ?? "").toContain("POST");
    }
  });

  test("does not allow any other origin", async () => {
    for (const origin of ["https://evil.example", "chrome-extension-evil://x", "http://localhost:5174"]) {
      const res = await preflight(origin);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    }
  });
});

describe("GET /rooms", () => {
  test("lists the default room with member and seated counts", async () => {
    const empty = v.parse(RoomListResponseSchema, await (await fetch(`${t.http}/rooms`)).json());
    expect(empty).toEqual({ rooms: [{ id: "lobby", memberCount: 0, seatedCount: 0 }] });

    const { client } = await join("alice");
    await join("bob");
    client.send({ type: "sit", seat: 3 });
    await client.next("seat-changed");
    const res = await fetch(`${t.http}/rooms`, { headers: { origin: EXTENSION_ORIGIN } });
    expect(res.headers.get("access-control-allow-origin")).toBe(EXTENSION_ORIGIN);
    expect(v.parse(RoomListResponseSchema, await res.json())).toEqual({
      rooms: [{ id: "lobby", memberCount: 2, seatedCount: 1 }],
    });
  });
});

describe("WebSocket /rooms/:id/ws", () => {
  test("upgrade to an unknown room is 404", async () => {
    const res = await fetch(`${t.http}/rooms/nope/ws`, { headers: { upgrade: "websocket" } });
    expect(res.status).toBe(404);
  });

  test("upgrade from a foreign origin is refused", async () => {
    const res = await fetch(`${t.http}/rooms/lobby/ws`, {
      headers: { upgrade: "websocket", origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
  });

  test("the site origin may connect", async () => {
    const c = await open(t.ws(), SITE_ORIGIN);
    c.send({ type: "join", nickname: "alice", avatar: 1 });
    expect((await c.next("snapshot")).room.members).toHaveLength(1);
  });

  test("join sends a snapshot to the joiner and member-joined to the others", async () => {
    const a = await join("alice", 1);
    expect(a.snapshot.room).toEqual({
      id: "lobby",
      seats: [null, null, null, null, null, null, null, null],
      members: [{ id: a.snapshot.self, nickname: "alice", avatar: 1 }],
      embed: null,
    });

    const b = await join("bob", 2);
    expect(b.snapshot.self).not.toBe(a.snapshot.self);
    expect(b.snapshot.room.members.map((m) => m.nickname)).toEqual(["alice", "bob"]);
    expect(await a.client.next("member-joined")).toEqual({
      type: "member-joined",
      member: { id: b.snapshot.self, nickname: "bob", avatar: 2 },
    });
    await b.client.none("member-joined");
  });

  test("sit on a free seat is broadcast to everyone, including the sitter", async () => {
    const a = await join("alice");
    const b = await join("bob");
    a.client.send({ type: "sit", seat: 0 });
    const expected = { type: "seat-changed", memberId: a.snapshot.self, seat: 0 } as const;
    expect(await a.client.next("seat-changed")).toEqual(expected);
    expect(await b.client.next("seat-changed")).toEqual(expected);
  });

  test("sit on a taken seat is refused with seat_taken and changes nothing", async () => {
    const a = await join("alice");
    const b = await join("bob");
    a.client.send({ type: "sit", seat: 4 });
    await b.client.next("seat-changed");

    b.client.send({ type: "sit", seat: 4 });
    expect((await b.client.next("error")).code).toBe("seat_taken");
    await a.client.none("seat-changed");
    const c = await join("carol");
    expect(c.snapshot.room.seats[4]).toBe(a.snapshot.self);
  });

  test("moving seats frees the old seat; sit null stands up", async () => {
    const a = await join("alice");
    const b = await join("bob");
    a.client.send({ type: "sit", seat: 1 });
    await b.client.next("seat-changed");
    a.client.send({ type: "sit", seat: 2 });
    expect(await b.client.next("seat-changed")).toMatchObject({ seat: 2 });
    b.client.send({ type: "sit", seat: 1 });
    expect(await b.client.next("seat-changed")).toMatchObject({ memberId: b.snapshot.self, seat: 1 });
    a.client.send({ type: "sit", seat: null });
    expect(await b.client.next("seat-changed")).toMatchObject({ memberId: a.snapshot.self, seat: null });

    const c = await join("carol");
    expect(c.snapshot.room.seats).toEqual([null, b.snapshot.self, null, null, null, null, null, null]);
  });

  test("leave frees the seat and tells the others", async () => {
    const a = await join("alice");
    const b = await join("bob");
    a.client.send({ type: "sit", seat: 5 });
    await b.client.next("seat-changed");
    a.client.send({ type: "leave" });
    expect(await b.client.next("member-left")).toEqual({ type: "member-left", memberId: a.snapshot.self });

    b.client.send({ type: "sit", seat: 5 });
    expect(await b.client.next("seat-changed")).toMatchObject({ memberId: b.snapshot.self, seat: 5 });
    // A left socket gets no further room traffic and can join again.
    await a.client.none("seat-changed");
    a.client.send({ type: "join", nickname: "alice", avatar: 0 });
    expect((await a.client.next("snapshot")).room.members).toHaveLength(2);
  });

  test("disconnect frees the seat and tells the others", async () => {
    const a = await join("alice");
    const b = await join("bob");
    a.client.send({ type: "sit", seat: 7 });
    await b.client.next("seat-changed");
    a.client.close();
    expect(await b.client.next("member-left")).toEqual({ type: "member-left", memberId: a.snapshot.self });
    const c = await join("carol");
    expect(c.snapshot.room.seats[7]).toBeNull();
    expect(c.snapshot.room.members.map((m) => m.nickname)).toEqual(["bob", "carol"]);
  });

  test("chat is relayed to everyone with the sender and server time", async () => {
    const a = await join("alice");
    const b = await join("bob");
    const before = Date.now();
    a.client.send({ type: "chat", text: "  hi 👋  " });
    for (const c of [a.client, b.client]) {
      const msg = await c.next("chat");
      expect(msg).toMatchObject({ type: "chat", memberId: a.snapshot.self, text: "hi 👋" });
      expect(msg.at).toBeGreaterThanOrEqual(before);
      expect(msg.at).toBeLessThanOrEqual(Date.now());
    }
  });

  test("messages before join are refused with not_joined", async () => {
    const a = await join("alice");
    const c = await open();
    c.send({ type: "sit", seat: 0 });
    expect((await c.next("error")).code).toBe("not_joined");
    c.send({ type: "chat", text: "hello" });
    expect((await c.next("error")).code).toBe("not_joined");
    await a.client.none("chat");
    await a.client.none("seat-changed");
  });

  test("a second join on the same socket is refused with already_joined", async () => {
    const a = await join("alice");
    a.client.send({ type: "join", nickname: "again", avatar: 0 });
    expect((await a.client.next("error")).code).toBe("already_joined");
    const b = await join("bob");
    expect(b.snapshot.room.members).toHaveLength(2);
  });

  test("invalid payloads are answered with bad_message and the socket keeps working", async () => {
    const a = await join("alice");
    const c = await open();
    const bad = [
      "not json",
      "{",
      JSON.stringify({ type: "nope" }),
      JSON.stringify({ type: "join", nickname: "x", avatar: 9 }),
      JSON.stringify({ type: "join", nickname: "a\u200bb", avatar: 0 }),
      JSON.stringify({ type: "join", nickname: "x", avatar: 0, admin: true }),
      JSON.stringify({ type: "sit", seat: 8 }),
      JSON.stringify({ type: "chat", text: "x".repeat(281) }),
    ];
    for (const raw of bad) {
      c.send(raw);
      expect((await c.next("error")).code).toBe("bad_message");
    }
    c.send(new Uint8Array([1, 2, 3]));
    expect((await c.next("error")).code).toBe("bad_message");
    await a.client.none("member-joined");

    c.send({ type: "join", nickname: "carol", avatar: 0 });
    expect((await c.next("snapshot")).room.members).toHaveLength(2);
  });

  test("a frame over the size limit closes the socket without affecting the room", async () => {
    const a = await join("alice");
    const c = await open();
    c.send("x".repeat(64 * 1024));
    await c.closed;
    const b = await join("bob");
    expect(b.snapshot.room.members.map((m) => m.nickname)).toEqual(["alice", "bob"]);
    await a.client.next("member-joined");
  });
});

describe("room capacity (ADR 0005)", () => {
  test(`the ${String(MAX_ROOM_MEMBERS + 1)}th member gets room-full and is closed; a freed slot can be reused`, async () => {
    const members = await Promise.all(Array.from({ length: MAX_ROOM_MEMBERS }, (_, i) => join(`m${String(i)}`)));
    expect(members.at(-1)?.snapshot.room.members).toHaveLength(MAX_ROOM_MEMBERS);

    const late = await open();
    late.send({ type: "join", nickname: "late", avatar: 0 });
    expect(await late.next("room-full")).toEqual({ type: "room-full" });
    await late.closed;
    await members[0]?.client.none("member-joined");

    members[0]?.client.close();
    const again = await join("again");
    expect(again.snapshot.room.members).toHaveLength(MAX_ROOM_MEMBERS);
  });

  test("members beyond the 8 seats stand and spectate; they cannot sit while every seat is taken", async () => {
    const members = await Promise.all(Array.from({ length: 9 }, (_, i) => join(`m${String(i)}`)));
    for (const [seat, m] of members.slice(0, 8).entries()) {
      m.client.send({ type: "sit", seat });
      await m.client.next("seat-changed");
    }
    const standing = members[8];
    if (standing === undefined) throw new Error("unreachable");
    standing.client.send({ type: "sit", seat: 0 });
    expect((await standing.client.next("error")).code).toBe("seat_taken");
    standing.client.send({ type: "chat", text: "still here" });
    expect(await standing.client.next("chat")).toMatchObject({ memberId: standing.snapshot.self });
  });
});
