import { afterEach, describe, expect, test } from "bun:test";
import { CLOSE_CODES, type RoomId } from "@omega/shared";
import { Room } from "../src/room";
import { RoomRegistry } from "../src/rooms";
import type { RoomPersistence } from "../src/server";
import { Client, postShare, start, tokenOf, type TestServer } from "./helpers";

/** Rooms come and go at run time (M5 S1, threat model §0 / §7 #2, S5). */

let t: TestServer | null = null;
const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await t?.server.stop(true);
  t = null;
});

const YT = "https://youtu.be/dQw4w9WgXcQ";
const share = (roomId: string, token: string): Promise<Response> => postShare(t ?? fail(), JSON.stringify({ url: YT }), { roomId, token });
function fail(): never {
  throw new Error("no server");
}
function fakeClock() {
  const clock = { ms: 1_000_000, now: () => clock.ms };
  return clock;
}
const total = (sizes: readonly number[]): number => sizes.reduce((a, b) => a + b, 0);

describe("RoomRegistry.removeRoom", () => {
  test("closes the room's sockets, joined or not, and leaves other rooms alone", async () => {
    const registry = new RoomRegistry();
    t = start({ registry });
    registry.addRoom(new Room("film-club"));
    const joined = await Client.join(t.ws("film-club"), "alice");
    const lurker = await Client.open(t.ws("film-club"));
    const lobby = await Client.join(t.ws(), "bob");
    clients.push(joined.client, lurker, lobby.client);
    lurker.send({ type: "ping", id: 1 });
    await lurker.next("pong");

    const room = registry.get("film-club");
    expect(room).toBeDefined();
    expect(registry.removeRoom(room ?? fail())).toBe(true);

    expect((await joined.client.closed).code).toBe(CLOSE_CODES.ROOM_CLOSED);
    expect((await lurker.closed).code).toBe(CLOSE_CODES.ROOM_CLOSED);
    lobby.client.send({ type: "chat", text: "still here" });
    expect((await lobby.client.next("chat")).text).toBe("still here");
    expect(registry.get("film-club")).toBeUndefined();
    const listed: unknown = await fetch(`${t.http}/rooms`).then((r) => r.json());
    expect(listed).toEqual({
      rooms: [{ id: "lobby", memberCount: 1, seatedCount: 0 }],
    });
    expect(registry.removeRoom(room ?? fail())).toBe(false);
  });

  test("removing a room sends its members no member-left fan-out: they just get ROOM_CLOSED (OME-423 note #2)", async () => {
    const registry = new RoomRegistry();
    t = start({ registry });
    registry.addRoom(new Room("film-club"));
    const members = await Promise.all(["alice", "bob", "carol"].map((name) => Client.join(t?.ws("film-club") ?? fail(), name)));
    for (const m of members) clients.push(m.client);
    // Everyone has seen everyone join before the room goes.
    await members[0]?.client.next("member-joined");
    await members[0]?.client.next("member-joined");
    await members[1]?.client.next("member-joined");

    registry.removeRoom(registry.get("film-club") ?? fail());
    for (const m of members) {
      expect((await m.client.closed).code).toBe(CLOSE_CODES.ROOM_CLOSED);
      expect(m.client.raw.filter((frame) => frame.includes('"member-left"'))).toEqual([]);
    }
  });

  test("an upgrade to a removed room gets 404, and a re-created room of the same id refuses the old members' share tokens", async () => {
    const registry = new RoomRegistry();
    t = start({ registry });
    registry.addRoom(new Room("film-club"));
    const a = await Client.join(t.ws("film-club"), "alice");
    clients.push(a.client);
    registry.removeRoom(registry.get("film-club") ?? fail());
    await a.client.closed;

    expect((await fetch(`${t.http}/rooms/film-club/ws`, { headers: { upgrade: "websocket" } })).status).toBe(404);
    expect((await share("film-club", tokenOf(a.snapshot))).status).toBe(404);
    registry.addRoom(new Room("film-club"));
    expect((await share("film-club", tokenOf(a.snapshot))).status).toBe(401);
  });

  test("a share still reading its body when the room goes is refused and never reaches the store", async () => {
    const registry = new RoomRegistry();
    const stored: string[] = [];
    const store: RoomPersistence = {
      listRooms: () => [],
      createRoom: () => undefined,
      deleteRoom: () => true,
      setLastActive: () => undefined,
      setEmbed: (id: RoomId) => {
        stored.push(id);
      },
      setLayout: () => undefined,
      setTitle: () => undefined,
      setControlPolicy: () => undefined,
    };
    t = start({ registry, store });
    registry.addRoom(new Room("film-club"));
    const a = await Client.join(t.ws("film-club"), "alice");
    clients.push(a.client);
    const held: { finish?: () => void } = {};
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`{"url":"${YT}"`));
        held.finish = () => {
          controller.enqueue(new TextEncoder().encode("}"));
          controller.close();
        };
      },
    });
    const slow = fetch(`${t.http}/rooms/film-club/share`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tokenOf(a.snapshot)}` },
      body,
    });
    await Bun.sleep(50);
    registry.removeRoom(registry.get("film-club") ?? fail());
    held.finish?.();
    expect((await slow).status).toBe(404);
    expect(stored).toEqual([]);
    expect(total(registry.perRoomSizes())).toBe(0);
  });

  test("1000 rooms created, used and removed: every per-room map is back at its baseline", async () => {
    const clock = fakeClock();
    const registry = new RoomRegistry();
    t = start({ registry, now: clock.now, maxConnections: 2000, maxConnectionsPerIp: 2000 });
    const baseline = registry.perRoomSizes();
    const lobby = await Client.join(t.ws(), "lobby-regular");
    clients.push(lobby.client);
    // The lobby's own entries are not part of the baseline above: count them now.
    const withLobby = total(registry.perRoomSizes());

    const ROOMS = 1000;
    const BATCH = 50;
    const members: Client[] = [];
    for (let from = 0; from < ROOMS; from += BATCH) {
      const batch = await Promise.all(
        Array.from({ length: BATCH }, async (_, j) => {
          const id = `room-${String(from + j)}`;
          registry.addRoom(new Room(id));
          const joined = await Client.join(t?.ws(id) ?? fail(), "alice");
          members.push(joined.client);
          return { id, ...joined };
        }),
      );
      // One at a time, each after a refill: the per-key and global share buckets see a calm client.
      for (const { id, client, snapshot } of batch) {
        clock.ms += 10_000;
        expect((await share(id, tokenOf(snapshot))).status).toBe(200);
        const url = (await client.next("embed-changed")).embed?.url ?? "";
        client.send({ type: "control", url, playing: true, position: 1 });
        await client.next("playback");
      }
    }
    expect(registry.size).toBe(ROOMS + 1);
    // Sockets, share grants, share buckets and control buckets: at least four entries per room.
    expect(total(registry.perRoomSizes())).toBeGreaterThanOrEqual(withLobby + 4 * ROOMS);

    for (let i = 0; i < ROOMS; i++) registry.removeRoom(registry.get(`room-${String(i)}`) ?? fail());
    await Promise.all(members.map((c) => c.closed));

    expect(registry.size).toBe(1);
    expect(total(registry.perRoomSizes())).toBe(withLobby);
    lobby.client.close();
    await lobby.client.closed;
    await Bun.sleep(20);
    expect(registry.perRoomSizes()).toEqual(baseline);
  }, 30_000);

  test("state asked for a room that is not (or no longer) registered is never stored", () => {
    const registry = new RoomRegistry();
    const counters = registry.perRoom(() => ({ n: 0 }));
    const gone = new Room("gone");
    registry.addRoom(gone);
    registry.removeRoom(gone);
    counters.get(gone).n++;
    counters.get(new Room("never")).n++;
    expect(counters.size).toBe(0);
    expect(total(registry.perRoomSizes())).toBe(0);
  });
});

describe("upgrade limiter before the room lookup (threat model S5)", () => {
  test("an unknown-room upgrade flood from one key is throttled: 10 get 404, the 11th 429 with Retry-After, other keys still get 404", async () => {
    const clock = fakeClock();
    t = start({ now: clock.now, trustProxy: true });
    const probe = (address: string, room: string) =>
      fetch(`${t?.http ?? fail()}/rooms/${room}/ws`, { headers: { upgrade: "websocket", "x-forwarded-for": address } });
    for (let i = 0; i < 10; i++) expect((await probe("198.51.100.1", `guess-${String(i)}`)).status).toBe(404);
    const refused = await probe("198.51.100.1", "guess-10");
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("2");
    expect((await probe("198.51.100.2", "guess-11")).status).toBe(404);
    clock.ms += 2000;
    expect((await probe("198.51.100.1", "guess-12")).status).toBe(404);
  });
});
