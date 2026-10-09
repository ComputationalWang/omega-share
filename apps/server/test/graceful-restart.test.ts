import { afterEach, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_LAYOUT, type ServerMessage } from "@omega/shared";
import { createConnection, type Connection, type SocketLike } from "../../web/src/connection";
import { SERVICE_RESTART } from "../src/ws";
import { openDatabase } from "../src/store/db";
import { RoomStore } from "../src/store/rooms";
import { SEAT_HOLD_MS } from "../src/room";
import { Client, start, tokenOf, type TestServer } from "./helpers";

// OME-504: SIGTERM stops accepting, closes sockets with a reconnectable code and flushes the store;
// clients come back on their own, in their seats, with the same embed, within 5 s.
const VIDEO = "dQw4w9WgXcQ";
const SHARE_BODY = JSON.stringify({ url: `https://www.youtube.com/watch?v=${VIDEO}` });

const dirs: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "omega-restart-"));
  dirs.push(dir);
  return dir;
};
const servers: TestServer[] = [];
afterEach(() => {
  for (const t of servers.splice(0)) void t.server.stop(true);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("drain (in process)", () => {
  test("closes every socket with SERVICE_RESTART and returns the seats held, as name hashes", async () => {
    const t = start({ rooms: ["lobby", "other"] });
    servers.push(t);
    const a = await Client.join(t.ws(), "alice-nick");
    const b = await Client.join(t.ws("other"), "bob-nick");
    const c = await Client.join(t.ws(), "standing-nick");
    a.client.send({ type: "sit", seat: 2 });
    await a.client.next("seat-changed");
    b.client.send({ type: "sit", seat: 0 });
    await b.client.next("seat-changed");

    const holds = await t.server.drain();
    for (const x of [a, b, c]) expect((await x.client.closed).code).toBe(SERVICE_RESTART);
    expect(holds.map((h) => [h.roomId, h.seat]).sort()).toEqual([
      ["lobby", 2],
      ["other", 0],
    ]);
    for (const h of holds) {
      expect(h.nameHash).toBeInstanceOf(Uint8Array);
      expect(h.nameHash.length).toBe(32);
      expect(new TextDecoder().decode(h.nameHash)).not.toContain("nick");
    }
    // Stopped accepting: a new upgrade fails.
    let refused = false;
    await Client.open(t.ws()).then(
      (late) => {
        late.close();
      },
      () => {
        refused = true;
      },
    );
    expect(refused).toBe(true);
  });

  test("a rejoin under the same name (any case or lookalike) gets its seat back; others don't; holds expire", async () => {
    const t1 = start({ rooms: ["lobby"] });
    servers.push(t1);
    const a = await Client.join(t1.ws(), "Alice");
    a.client.send({ type: "sit", seat: 3 });
    await a.client.next("seat-changed");
    const holds = await t1.server.drain();

    let wall = 1_000_000;
    const t2 = start({ rooms: ["lobby"], seatHolds: holds, wallNow: () => wall });
    servers.push(t2);
    const watcher = await Client.join(t2.ws(), "watcher");
    const stranger = await Client.join(t2.ws(), "mallory");
    expect(stranger.snapshot.room.seats).not.toContain(stranger.snapshot.self);
    const back = await Client.join(t2.ws(), "alice");
    expect(back.snapshot.room.seats[3]).toBe(back.snapshot.self);
    // Others see the join, then the seat.
    expect((await watcher.client.next("member-joined", 1000)).member.id).toBe(stranger.snapshot.self);
    expect((await watcher.client.next("member-joined", 1000)).member.id).toBe(back.snapshot.self);
    expect(await watcher.client.next("seat-changed", 1000)).toEqual({ type: "seat-changed", memberId: back.snapshot.self, seat: 3 });
    // Used once: leave and rejoin stands.
    back.client.close();
    await back.client.closed;
    const again = await Client.join(t2.ws(), "alice");
    expect(again.snapshot.room.seats).not.toContain(again.snapshot.self);

    // Expired holds are ignored.
    const t3 = start({ rooms: ["lobby"], seatHolds: holds, wallNow: () => wall });
    servers.push(t3);
    wall += SEAT_HOLD_MS + 1;
    const late = await Client.join(t3.ws(), "Alice");
    expect(late.snapshot.room.seats).not.toContain(late.snapshot.self);
    for (const x of [watcher, stranger, again, late]) x.client.close();
  });

  test("a held seat someone else took first stays theirs", async () => {
    const t1 = start({ rooms: ["lobby"] });
    servers.push(t1);
    const a = await Client.join(t1.ws(), "alice");
    a.client.send({ type: "sit", seat: 1 });
    await a.client.next("seat-changed");
    const holds = await t1.server.drain();
    const t2 = start({ rooms: ["lobby"], seatHolds: holds });
    servers.push(t2);
    const quick = await Client.join(t2.ws(), "quick");
    quick.client.send({ type: "sit", seat: 1 });
    await quick.client.next("seat-changed");
    const back = await Client.join(t2.ws(), "alice");
    expect(back.snapshot.room.seats[1]).toBe(quick.snapshot.self);
    quick.client.close();
    back.client.close();
  });
});

describe("RoomStore seat holds", () => {
  test("saved holds are taken once, and a deleted room's holds go with it", () => {
    const db = openDatabase(join(tempDir(), "omega.db"));
    const store = new RoomStore(db);
    for (const id of ["lobby", "gone"]) store.createRoom({ id, title: "", createdAt: 1, layout: DEFAULT_LAYOUT });
    const hash = (n: number) => new Uint8Array(32).fill(n);
    store.saveSeatHolds([
      { roomId: "lobby", nameHash: hash(1), seat: 0 },
      { roomId: "gone", nameHash: hash(2), seat: 4 },
    ]);
    store.deleteRoom("gone");
    expect(store.takeSeatHolds()).toEqual([{ roomId: "lobby", nameHash: hash(1), seat: 0 }]);
    expect(store.takeSeatHolds()).toEqual([]);
    db.close();
  });
});

/** A free loopback port: bind 0, read it, let go. */
function freePort(): number {
  const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data: () => undefined } });
  const port = s.port;
  s.stop(true);
  return port;
}

async function boot(env: Record<string, string>): Promise<Subprocess<"ignore", "pipe", "pipe">> {
  const proc = Bun.spawn(["bun", join(import.meta.dir, "../src/index.ts")], {
    env: { ...process.env, ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = proc.stdout.getReader();
  let out = "";
  const deadline = Date.now() + 10_000;
  while (!out.includes("omega-share server on")) {
    if (Date.now() > deadline) throw new Error(`server did not start: ${out}`);
    const { value, done } = await reader.read();
    if (done) throw new Error(`server exited: ${out}${await new Response(proc.stderr).text()}`);
    out += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  return proc;
}

interface Probe {
  conn: Connection;
  closes: number[];
  snapshots: Extract<ServerMessage, { type: "snapshot" }>[];
  inbox: ServerMessage[];
}

/** The web app's own reconnecting connection (apps/web/src/connection.ts) over a Bun WebSocket. */
function probe(url: string, nickname: string): Probe {
  const closes: number[] = [];
  const snapshots: Probe["snapshots"] = [];
  const inbox: ServerMessage[] = [];
  const conn = createConnection<Timer>({
    url,
    join: { type: "join", nickname, avatar: 0 },
    createSocket: (u) => {
      const ws = new WebSocket(u);
      const s: SocketLike = {
        send: (d) => {
          ws.send(d);
        },
        close: (code) => {
          ws.close(code);
        },
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
      };
      ws.onopen = () => s.onopen?.();
      ws.onmessage = (ev: MessageEvent<unknown>) => s.onmessage?.({ data: ev.data });
      ws.onclose = (ev) => {
        closes.push(ev.code);
        s.onclose?.({ code: ev.code });
      };
      ws.onerror = () => s.onerror?.();
      return s;
    },
    onEvent: (e) => {
      if (e.type !== "message") return;
      inbox.push(e.msg);
      if (e.msg.type === "snapshot") snapshots.push(e.msg);
    },
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => {
      clearTimeout(h);
    },
  });
  return { conn, closes, snapshots, inbox };
}

async function until(what: string, ok: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await Bun.sleep(10);
  }
}

describe("graceful restart (process)", () => {
  const procs: Subprocess[] = [];
  const probes: Probe[] = [];
  afterEach(() => {
    for (const p of probes.splice(0)) p.conn.close();
    for (const p of procs.splice(0)) p.kill("SIGKILL");
  });

  test(
    "SIGTERM exits 0 after closing with SERVICE_RESTART; clients are back in their seats with the same embed within 5 s",
    async () => {
      const port = freePort();
      const env = {
        PORT: String(port),
        HOST: "127.0.0.1",
        METRICS_PORT: String(freePort()),
        DB_PATH: join(tempDir(), "omega.db"),
        ADMIN_SOCKET: "off",
      };
      const url = `ws://127.0.0.1:${String(port)}/rooms/lobby/ws`;
      const first = await boot(env);
      procs.push(first);

      const names = ["ann", "ben", "cat"];
      for (const n of names) probes.push(probe(url, n));
      await until("first snapshots", () => probes.every((p) => p.snapshots.length === 1));
      const firstSnap = probes[0]?.snapshots[0];
      if (firstSnap === undefined) throw new Error("no snapshot");
      const shared = await fetch(`http://127.0.0.1:${String(port)}/rooms/lobby/share`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${tokenOf(firstSnap)}` },
        body: SHARE_BODY,
      });
      expect(shared.status).toBe(200);
      probes.forEach((p, i) => p.conn.send({ type: "sit", seat: i + 1 }));
      await until("seated", () =>
        probes.every((p, i) => p.inbox.some((m) => m.type === "seat-changed" && m.memberId === p.snapshots[0]?.self && m.seat === i + 1)),
      );

      const t0 = performance.now();
      first.kill("SIGTERM");
      expect(await first.exited).toBe(0);
      for (const p of probes) expect(p.closes).toEqual([SERVICE_RESTART]);

      const second = await boot(env);
      procs.push(second);
      await until("rejoined", () => probes.every((p) => p.snapshots.length === 2), 5000);
      const elapsed = performance.now() - t0;
      probes.forEach((p, i) => {
        const snap = p.snapshots[1];
        expect(snap?.room.seats[i + 1]).toBe(snap?.self ?? "");
        expect(snap?.room.embed?.url).toBe(`https://www.youtube.com/embed/${VIDEO}`);
      });
      expect(elapsed).toBeLessThanOrEqual(5000);
      // No error lines on a clean drain.
      second.kill("SIGTERM");
      expect(await second.exited).toBe(0);
      expect(await new Response(first.stderr).text()).toBe("");
    },
    { timeout: 30_000 },
  );
});
