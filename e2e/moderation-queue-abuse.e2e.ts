// M6 moderation and queue abuse suite (OME-510, ADR 0030 owner moderation, ADR 0031 playback queue): hand-crafted
// frames over raw WebSockets, the way an attacker without our site would send them, against the real server. Every
// case checks that the server refuses with the documented code, changes nothing, tells nobody, and that the room
// stays healthy (an honest member still hears it, a late joiner's snapshot is unchanged).
//
// It starts a server of its own for each test (on OMEGA_SERVER_PORT + 6, like the tunnel lanes' +1/+2/+4), so a room's
// queue, kick cooldown and spent buckets never reach a retry or a repeat, rather than using the
// e2e one: the e2e server runs without TRUST_PROXY, so every loopback socket is unkeyed and skips the per-address
// limits (join limiter, members per address) and the kick cooldown. This one trusts the rightmost X-Forwarded-For
// entry from a loopback peer (ADR 0015 §5), so each socket picks the address the server keys it on. Every socket
// gets an address of its own except where a case is about one address (the kick cooldown), so the per-address caps
// never confound the queue's member and room buckets. The server boots from the same seeded DB as the e2e server
// (fixtures/seed-rooms.ts: owned rooms with known owner tokens and invite keys), one room per test.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { expect, test as base } from "./support/csp";
import {
  CLOSE_CODES,
  DEFAULT_ROOM_ID,
  MAX_URL_LENGTH,
  QUEUE_ADD_MEMBER_BURST,
  QUEUE_ADD_MEMBER_REFILL_MS,
  QUEUE_ADD_ROOM_BURST,
  QUEUE_ADD_ROOM_REFILL_MS,
  QUEUE_ENDED_DEBOUNCE_MS,
  QUEUE_MAX,
  RETRY_AFTER_MAX_MS,
  parseServerMessage,
  type ErrorCode,
  type MemberId,
  type ServerMessage,
} from "@omega/shared";
import { PORTS, ROOT } from "./support/apps";
import { ownedRoom } from "./support/owned-rooms";

const SERVER_PORT = PORTS.server + 6;
const SITE_ORIGIN = `http://localhost:${String(PORTS.web)}`;
/** Denied for generic embeds on this server (GENERIC_EMBED_DENYLIST, ADR 0024 §6). */
const DENIED_DOMAIN = "denied-embeds.org";
/** A thrown error or an unhandled rejection in the server's output (not a log line that merely says "error"). */
const SERVER_FAULT = /\b(Error|TypeError|RangeError):|uncaught|unhandled/i;

type Of<T extends ServerMessage["type"]> = Extract<ServerMessage, { type: T }>;

interface Closed {
  readonly code: number;
  readonly reason: string;
}

/**
 * A WebSocket client written by hand on `node:http` (RFC 6455: masked client frames, unmasked server frames), so a
 * case can send any bytes and choose the `X-Forwarded-For` address. Server text frames are parsed with the shared
 * schema; one that doesn't parse is kept in `unparsed` and fails the test.
 */
class RawSocket {
  readonly frames: ServerMessage[] = [];
  /** Every text frame the server sent, as received. */
  readonly texts: string[] = [];
  readonly unparsed: string[] = [];
  closed: Closed | null = null;
  readonly #socket: Socket;
  #buf: Buffer = Buffer.alloc(0);
  #parts: Buffer[] = [];
  #pings = 0;

  private constructor(socket: Socket) {
    this.#socket = socket;
    socket.on("data", (chunk: Buffer) => {
      this.#feed(chunk);
    });
    socket.on("error", () => undefined);
    socket.on("close", () => {
      this.closed ??= { code: 1006, reason: "" };
    });
  }

  /** The upgrade through `path`, from `addr`. Rejects with the refusal's status when the server says no. */
  static connect(path: string, addr: string): Promise<RawSocket> {
    return new Promise((resolve, reject) => {
      const req = request({
        host: "127.0.0.1",
        port: SERVER_PORT,
        path,
        agent: false,
        headers: {
          host: `127.0.0.1:${String(SERVER_PORT)}`,
          origin: SITE_ORIGIN,
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-version": "13",
          "sec-websocket-key": randomBytes(16).toString("base64"),
          "x-forwarded-for": addr,
        },
      });
      req.on("upgrade", (_res, socket: Socket, head: Buffer) => {
        const raw = new RawSocket(socket);
        if (head.length > 0) raw.#feed(head);
        resolve(raw);
      });
      req.on("response", (res) => {
        res.resume();
        reject(new Error(`upgrade refused: HTTP ${String(res.statusCode)}`));
      });
      req.on("error", reject);
      req.end();
    });
  }

  #feed(chunk: Buffer): void {
    this.#buf = Buffer.concat([this.#buf, chunk]);
    for (;;) {
      const buf = this.#buf;
      if (buf.length < 2) return;
      const fin = (buf.readUInt8(0) & 0x80) !== 0;
      const opcode = buf.readUInt8(0) & 0x0f;
      const masked = (buf.readUInt8(1) & 0x80) !== 0;
      let length = buf.readUInt8(1) & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buf.length < 4) return;
        length = buf.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buf.length < 10) return;
        length = Number(buf.readBigUInt64BE(2));
        offset = 10;
      }
      if (masked) offset += 4;
      if (buf.length < offset + length) return;
      const payload = buf.subarray(offset, offset + length);
      this.#buf = buf.subarray(offset + length);
      this.#onFrame(fin, opcode, payload);
    }
  }

  #onFrame(fin: boolean, opcode: number, payload: Buffer): void {
    if (opcode === 0x8) {
      this.closed ??= { code: payload.length >= 2 ? payload.readUInt16BE(0) : 1005, reason: payload.subarray(2).toString("utf8") };
      this.#write(0x8, payload.subarray(0, 2));
      this.#socket.end();
      return;
    }
    if (opcode === 0x9) {
      this.#write(0xa, payload);
      return;
    }
    if (opcode !== 0x1 && opcode !== 0x0) return;
    this.#parts.push(Buffer.from(payload));
    if (!fin) return;
    const text = Buffer.concat(this.#parts).toString("utf8");
    this.#parts = [];
    this.texts.push(text);
    const msg = parseServerMessage(text);
    if (msg === null) this.unparsed.push(text);
    else this.frames.push(msg);
  }

  #write(opcode: number, payload: Buffer): void {
    if (this.#socket.destroyed || !this.#socket.writable) return;
    const mask = randomBytes(4);
    const n = payload.length;
    let head: Buffer;
    if (n < 126) head = Buffer.from([0x80 | opcode, 0x80 | n]);
    else if (n < 65_536) head = Buffer.from([0x80 | opcode, 0x80 | 126, n >> 8, n & 0xff]);
    else throw new Error("frame too large for this client");
    const body = Buffer.alloc(n);
    for (let i = 0; i < n; i++) body.writeUInt8(payload.readUInt8(i) ^ mask.readUInt8(i % 4), i);
    this.#socket.write(Buffer.concat([head, mask, body]));
  }

  /** A text frame with `msg` JSON-encoded. */
  send(msg: unknown): void {
    this.sendText(JSON.stringify(msg));
  }

  sendText(text: string): void {
    this.#write(0x1, Buffer.from(text, "utf8"));
  }

  sendBinary(bytes: Buffer): void {
    this.#write(0x2, bytes);
  }

  destroy(): void {
    this.#socket.destroy();
  }

  of<T extends ServerMessage["type"]>(type: T, from = 0): Of<T>[] {
    return this.frames.slice(from).filter((m): m is Of<T> => m.type === type);
  }

  async waitFor<T>(find: () => T | undefined, what: string, ms = 5_000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
      const found = find();
      if (found !== undefined) return found;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await sleep(10);
    }
  }

  async waitClosed(ms = 5_000): Promise<Closed> {
    return this.waitFor(() => this.closed ?? undefined, "the socket to close", ms);
  }

  /**
   * Barrier: a `ping` and its `pong`. The server handles one socket's frames in order, so everything it did for the
   * frames sent before arrives before the pong.
   */
  async sync(): Promise<void> {
    const id = ++this.#pings;
    this.send({ type: "ping", id });
    await this.waitFor(() => this.of("pong").find((p) => p.id === id), "a pong");
  }
}

interface Joinable {
  readonly id: string;
  readonly inviteKey?: string;
  readonly ownerToken?: string;
}

interface Member {
  readonly sock: RawSocket;
  readonly self: MemberId;
  readonly owner: boolean;
  readonly snapshot: Of<"snapshot">;
}

interface Who {
  readonly nickname: string;
  /** `owner`: the room's owner token. `forged`: a wrong one. Default `guest`: only the invite key. */
  readonly as?: "owner" | "guest" | "forged";
  /** The address the server keys this socket on; default a fresh one. */
  readonly addr?: string;
}

interface Net {
  /** An address no other socket of this run has used. */
  readonly freshAddr: () => string;
  readonly connect: (room: Joinable, addr?: string) => Promise<RawSocket>;
  readonly join: (room: Joinable, who: Who) => Promise<Member>;
  /** Sends `join` over a new socket and returns it without waiting for an answer. */
  readonly tryJoin: (room: Joinable, who: Who) => Promise<RawSocket>;
}

interface ServerFixture {
  readonly log: () => string;
}

const FORGED_OWNER_TOKEN = "ForgedOwnerToken".padEnd(22, "x");

function startServer(): { server: ServerFixture; stop: () => Promise<void> } {
  const dir = mkdtempSync(join(tmpdir(), "omega-moderation-queue-abuse-"));
  const db = join(dir, "omega.db");
  const seeded = spawnSync("bun", ["e2e/fixtures/seed-rooms.ts", db], { cwd: ROOT, encoding: "utf8" });
  if (seeded.status !== 0) throw new Error(`seeding failed:\n${seeded.stdout}\n${seeded.stderr}`);
  // The server's own settings come from here alone, not from the runner's PUBLIC_ORIGIN, STATIC_DIR and the like.
  const unset = new Set(["PUBLIC_ORIGIN", "STATIC_DIR", "METRICS_PORT", "GENERIC_EMBEDS", "EXTENSION_IDS", "MAX_CONNECTIONS"]);
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !unset.has(key))),
    PORT: String(SERVER_PORT),
    HOST: "127.0.0.1",
    SITE_ORIGIN,
    TRUST_PROXY: "loopback",
    DB_PATH: db,
    ADMIN_SOCKET: "off",
    GENERIC_EMBED_DENYLIST: DENIED_DOMAIN,
  };
  let output = "";
  const child: ChildProcess = spawn("bun", ["apps/server/src/index.ts"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (d: Buffer) => (output += d.toString()));
  child.stderr?.on("data", (d: Buffer) => (output += d.toString()));
  return {
    server: { log: () => output },
    stop: () =>
      new Promise((resolve) => {
        rmSync(dir, { recursive: true, force: true });
        if (child.exitCode !== null || child.signalCode !== null) resolve();
        else {
          child.once("exit", () => {
            resolve();
          });
          child.kill();
        }
      }),
  };
}

const test = base.extend<{ net: Net; server: ServerFixture }>({
  server: [
    async ({}, use) => {
      const { server, stop } = startServer();
      const line = `omega-share server on http://127.0.0.1:${String(SERVER_PORT)}/`;
      const deadline = Date.now() + 15_000;
      while (!server.log().includes(line)) {
        if (Date.now() > deadline) {
          await stop();
          throw new Error(`the server did not start on :${String(SERVER_PORT)}:\n${server.log()}`);
        }
        await sleep(100);
      }
      await use(server);
      await stop();
    },
    { timeout: 60_000 },
  ],
  net: async ({ server }, use) => {
    const opened: RawSocket[] = [];
    let next = 1;
    const freshAddr = (): string => `198.18.${String(next >> 8)}.${String(next++ & 0xff)}`;
    const connect: Net["connect"] = async (room, addr = freshAddr()) => {
      const sock = await RawSocket.connect(`/rooms/${room.id}/ws`, addr);
      opened.push(sock);
      return sock;
    };
    const tryJoin: Net["tryJoin"] = async (room, who) => {
      const sock = await connect(room, who.addr);
      const secrets =
        who.as === "owner"
          ? { ownerToken: room.ownerToken }
          : who.as === "forged"
            ? { ownerToken: FORGED_OWNER_TOKEN, inviteKey: room.inviteKey }
            : { inviteKey: room.inviteKey };
      sock.send({ type: "join", nickname: who.nickname, avatar: 0, ...secrets });
      return sock;
    };
    const join: Net["join"] = async (room, who) => {
      const sock = await tryJoin(room, who);
      const snapshot = await sock.waitFor(() => sock.of("snapshot")[0], `${who.nickname}'s snapshot`);
      return { sock, self: snapshot.self, owner: snapshot.owner === true, snapshot };
    };
    await use({ freshAddr, connect, join, tryJoin });
    for (const sock of opened) {
      expect(sock.unparsed, "every server frame parses with the shared schema").toEqual([]);
      sock.destroy();
    }
    expect(server.log()).not.toMatch(SERVER_FAULT);
  },
});

/** Flushes what the server has sent to each socket so far, in turn. */
async function settle(...members: readonly (RawSocket | { readonly sock: RawSocket })[]): Promise<void> {
  for (const m of members) await (m instanceof RawSocket ? m : m.sock).sync();
}

/** Sends `frame` and returns the one error code the server answers with (nothing else may come back for it). */
async function answer(sock: RawSocket, frame: unknown): Promise<ErrorCode> {
  const mark = sock.frames.length;
  sock.send(frame);
  const err = await sock.waitFor(() => sock.of("error", mark)[0], `an error for ${JSON.stringify(frame)}`);
  await sock.sync();
  expect(sock.frames.slice(mark).filter((m) => m.type !== "pong").map((m) => m.type), `only the error answers ${JSON.stringify(frame)}`).toEqual(["error"]);
  // Two frames per call: stay under the per-socket limiter (20 at once, 10 a second) so a long run isn't answered with rate_limited.
  await sleep(200);
  return err.code;
}

type Outcome = { readonly kind: "added" } | { readonly kind: "refused"; readonly code: ErrorCode; readonly retryAfterMs: number | undefined };

/** A `queue-add`: the server either broadcasts the change (the adder hears it too) or answers the adder with an error. */
async function add(m: Member, url: string): Promise<Outcome> {
  const mark = m.sock.frames.length;
  m.sock.send({ type: "queue-add", url });
  const hit = await m.sock.waitFor(
    () => m.sock.frames.slice(mark).find((f) => f.type === "error" || f.type === "queue-changed" || f.type === "embed-changed"),
    `an answer to queue-add ${url.slice(0, 80)}`,
  );
  // The rest of an accepted add (embed-changed and queue-changed) has arrived too once the pong has.
  await m.sock.sync();
  return hit.type === "error" ? { kind: "refused", code: hit.code, retryAfterMs: hit.retryAfterMs } : { kind: "added" };
}

/** A distinct valid YouTube watch URL per `n` (the id is 11 characters). */
const video = (n: number): string => `https://www.youtube.com/watch?v=vid${String(n).padStart(8, "0")}`;

const queueLengths = (sock: RawSocket, from = 0): number[] => sock.of("queue-changed", from).map((q) => q.queue.length);

/** What a joiner sees now: the room as a fresh snapshot has it. */
async function snapshotNow(net: Net, room: Joinable, nickname: string): Promise<Of<"snapshot">> {
  return (await net.join(room, { nickname })).snapshot;
}

const ROOM_STATE_UNTOUCHED = { embed: null, queue: [] } as const;

test.describe("owner moderation frames from members who are not the owner (ADR 0030 §1)", () => {
  test("a guest's kick, mute and control-policy are refused with not_owner: no effect on the target or the policy, nobody elevated", async ({ net }) => {
    const room = ownedRoom("abmod");
    const owner = await net.join(room, { nickname: "the-owner", as: "owner" });
    expect(owner.owner).toBe(true);
    const guest = await net.join(room, { nickname: "the-guest" });
    const victim = await net.join(room, { nickname: "the-victim" });
    expect([guest.owner, victim.owner]).toEqual([false, false]);
    expect(guest.snapshot.owner).toBeUndefined();
    await settle(owner, guest, victim);
    const [ownerMark, victimMark] = [owner.sock.frames.length, victim.sock.frames.length];

    // The owner check comes before the target check: even a target that doesn't exist, the owner, or the sender gets not_owner.
    const attacks: unknown[] = [
      { type: "kick", memberId: victim.self },
      { type: "mute", memberId: victim.self, muted: true },
      { type: "control-policy", policy: "owner" },
      { type: "kick", memberId: owner.self },
      { type: "mute", memberId: guest.self, muted: true },
      { type: "kick", memberId: "no-such-member" },
      { type: "control-policy", policy: "everyone" },
      { type: "title-set", title: "pwned" },
    ];
    for (const frame of attacks) expect(await answer(guest.sock, frame), JSON.stringify(frame)).toBe("not_owner");
    // Joining again with the owner's frames in hand doesn't elevate either.
    expect(await answer(guest.sock, { type: "join", nickname: "the-guest", avatar: 0, ownerToken: FORGED_OWNER_TOKEN })).toBe("already_joined");
    expect(await answer(guest.sock, { type: "kick", memberId: victim.self })).toBe("not_owner");

    await settle(owner, victim);
    // Nobody heard anything: no member-left, member-muted or control-policy-changed, and the victim's socket is open.
    expect(owner.sock.frames.slice(ownerMark).filter((m) => m.type !== "pong")).toEqual([]);
    expect(victim.sock.frames.slice(victimMark).filter((m) => m.type !== "pong")).toEqual([]);
    expect(victim.sock.closed).toBeNull();

    // The victim chats (not muted), and plays under the default policy (no embed is not control_owner_only).
    victim.sock.send({ type: "chat", text: "still here" });
    await owner.sock.waitFor(() => owner.sock.of("chat").find((c) => c.text === "still here"), "the victim's chat");
    expect(victim.sock.of("error", victimMark)).toEqual([]);
    expect(await answer(victim.sock, { type: "control", url: "https://www.youtube.com/embed/aaaaaaaaaaa", playing: true, position: 0 })).toBe("no_embed");

    // A late joiner's snapshot: nobody muted, the policy is still the default.
    const late = (await snapshotNow(net, room, "late-comer")).room;
    expect(late.members.map((m) => m.muted === true)).not.toContain(true);
    expect(late.controlPolicy ?? "everyone").toBe("everyone");
    expect(late.members.map((m) => m.nickname).sort()).toEqual(["late-comer", "the-guest", "the-owner", "the-victim"]);
  });

  test("a socket that joined with a forged owner token is a guest: its kick flood is refused, then closed with 4400, and the room is untouched", async ({ net }) => {
    const room = ownedRoom("abforge");
    const owner = await net.join(room, { nickname: "the-owner", as: "owner" });
    const victim = await net.join(room, { nickname: "the-victim" });
    const forger = await net.join(room, { nickname: "the-forger", as: "forged" });
    expect(forger.owner).toBe(false);
    expect(forger.snapshot.owner).toBeUndefined();
    await settle(owner, victim);
    const [ownerMark, victimMark] = [owner.sock.frames.length, victim.sock.frames.length];

    // Each refused owner frame counts toward the 4400 close (ADR 0030 §1). Paced under the per-socket limiter.
    for (let i = 0; i < 40 && forger.sock.closed === null; i++) {
      forger.sock.send(i % 3 === 0 ? { type: "kick", memberId: victim.self } : i % 3 === 1 ? { type: "mute", memberId: victim.self, muted: true } : { type: "control-policy", policy: "owner" });
      await sleep(110);
    }
    const closed = await forger.sock.waitClosed();
    expect(closed.code).toBe(CLOSE_CODES.BAD_MESSAGES);
    const codes = forger.sock.of("error").map((e) => e.code);
    expect(codes.length).toBeGreaterThanOrEqual(15);
    expect(new Set(codes)).toEqual(new Set(["not_owner"]));

    await settle(owner, victim);
    for (const heard of [owner, victim]) {
      const frames = heard.sock.frames.slice(heard === owner ? ownerMark : victimMark);
      expect(frames.filter((m) => m.type !== "pong" && m.type !== "member-left").map((m) => m.type)).toEqual([]);
      // The only departure anyone sees is the forger's own.
      expect(frames.filter((m) => m.type === "member-left").map((m) => m.memberId)).toEqual([forger.self]);
    }
    expect(victim.sock.closed).toBeNull();

    // The owner can still moderate, and the late joiner's snapshot shows the room as it was.
    owner.sock.send({ type: "mute", memberId: victim.self, muted: true });
    await victim.sock.waitFor(() => victim.sock.of("member-muted").find((m) => m.memberId === victim.self && m.muted), "the owner's mute");
    const late = (await snapshotNow(net, room, "late-comer")).room;
    expect(late.controlPolicy ?? "everyone").toBe("everyone");
    expect(late.members.filter((m) => m.muted === true).map((m) => m.nickname)).toEqual(["the-victim"]);
  });
});

test.describe("queue floods (ADR 0031 §3)", () => {
  test("the queue never passes QUEUE_MAX: eight members add until queue_full, and every other refusal is a rate limit with a retry time", async ({ net }) => {
    test.setTimeout(180_000);
    const room = ownedRoom("abcap");
    const watcher = await net.join(room, { nickname: "watcher" });
    const adders: Member[] = [];
    for (let i = 0; i < 8; i++) adders.push(await net.join(room, { nickname: `adder-${String(i)}` }));
    await settle(watcher);
    const mark = watcher.sock.frames.length;

    // The room's bucket (QUEUE_ADD_ROOM_BURST at once, then one per QUEUE_ADD_ROOM_REFILL_MS) paces the fill; the
    // first add starts the empty room's playback, so the queue is full after 1 + QUEUE_MAX accepted adds.
    const started = Date.now();
    const accepted = new Map<MemberId, number>();
    const refusals: Outcome[] = [];
    let fullAt = -1;
    for (let n = 0; n < 400 && (fullAt < 0 || n < fullAt + 6); n++) {
      const adder = adders[n % adders.length];
      if (adder === undefined) throw new Error("no adder");
      const out = await add(adder, video(n));
      if (out.kind === "added") accepted.set(adder.self, (accepted.get(adder.self) ?? 0) + 1);
      else {
        refusals.push(out);
        if (out.code === "queue_full" && fullAt < 0) fullAt = n;
      }
      await sleep(300);
    }
    const elapsed = Date.now() - started;
    expect(fullAt, "queue_full was reached").toBeGreaterThanOrEqual(0);

    const total = [...accepted.values()].reduce((a, b) => a + b, 0);
    expect(total).toBe(1 + QUEUE_MAX);
    // Every refusal is a documented one; rate limits say when to come back.
    for (const r of refusals) {
      if (r.kind !== "refused") continue;
      expect(["rate_limited", "queue_full"]).toContain(r.code);
      if (r.code === "rate_limited") expect(r.retryAfterMs).toBeGreaterThan(0);
      if (r.code === "rate_limited") expect(r.retryAfterMs).toBeLessThanOrEqual(RETRY_AFTER_MAX_MS);
    }
    const afterFull = refusals.slice(refusals.findIndex((r) => r.kind === "refused" && r.code === "queue_full"));
    expect(afterFull.every((r) => r.kind === "refused" && (r.code === "queue_full" || r.code === "rate_limited"))).toBe(true);
    // Nobody had more than their own share: the burst plus what their bucket refilled meanwhile.
    for (const count of accepted.values()) {
      expect(count).toBeLessThanOrEqual(QUEUE_ADD_MEMBER_BURST + Math.ceil(elapsed / QUEUE_ADD_MEMBER_REFILL_MS));
    }
    // More than one member got items in: one member's share doesn't lock the others out.
    expect(accepted.size).toBeGreaterThan(1);

    // What everyone heard: one start, and a queue that grew by one to exactly QUEUE_MAX and never beyond.
    await settle(watcher);
    expect(watcher.sock.of("embed-changed", mark)).toHaveLength(1);
    const lengths = queueLengths(watcher.sock, mark);
    expect(Math.max(...lengths)).toBe(QUEUE_MAX);
    expect(lengths.at(-1)).toBe(QUEUE_MAX);
    for (const a of adders) expect(Math.max(0, ...queueLengths(a.sock))).toBeLessThanOrEqual(QUEUE_MAX);
    const late = (await snapshotNow(net, room, "late-comer")).room;
    expect(late.queue ?? []).toHaveLength(QUEUE_MAX);
    expect(new Set((late.queue ?? []).map((i) => i.id)).size).toBe(QUEUE_MAX);
  });

  test("the member's burst and the room's burst: one member's flood is refused with a retry time while others still add, and the room's limit leaves the member their own add", async ({ net }) => {
    const room = ownedRoom("abrate");
    const watcher = await net.join(room, { nickname: "watcher" });
    const [a, b, c, d] = await Promise.all(["adder-a", "adder-b", "adder-c", "adder-d"].map((nickname) => net.join(room, { nickname })));
    if (a === undefined || b === undefined || c === undefined || d === undefined) throw new Error("members did not join");
    await settle(watcher);
    const mark = watcher.sock.frames.length;
    let n = 0;
    const addOne = (m: Member): Promise<Outcome> => add(m, video(n++));

    // A spends their burst; the next add is refused and says when to come back (about one refill away).
    for (let i = 0; i < QUEUE_ADD_MEMBER_BURST; i++) expect(await addOne(a)).toEqual({ kind: "added" });
    const limited = await addOne(a);
    expect(limited).toMatchObject({ kind: "refused", code: "rate_limited" });
    if (limited.kind !== "refused") throw new Error("unreachable");
    expect(limited.retryAfterMs).toBeGreaterThan(0);
    expect(limited.retryAfterMs).toBeLessThanOrEqual(QUEUE_ADD_MEMBER_REFILL_MS);
    // A's flood doesn't touch B and C: each still adds their whole burst.
    for (const m of [b, c]) for (let i = 0; i < QUEUE_ADD_MEMBER_BURST; i++) expect(await addOne(m)).toEqual({ kind: "added" });

    // 9 of the room's QUEUE_ADD_ROOM_BURST are spent: D gets the last one, then the room's limit refuses them.
    expect(QUEUE_ADD_ROOM_BURST).toBe(3 * QUEUE_ADD_MEMBER_BURST + 1);
    expect(await addOne(d)).toEqual({ kind: "added" });
    for (let i = 0; i < 2; i++) {
      const refused = await addOne(d);
      expect(refused).toMatchObject({ kind: "refused", code: "rate_limited" });
      if (refused.kind !== "refused") throw new Error("unreachable");
      expect(refused.retryAfterMs).toBeGreaterThan(0);
      expect(refused.retryAfterMs).toBeLessThanOrEqual(QUEUE_ADD_ROOM_REFILL_MS);
    }
    await settle(watcher);
    // 10 adds went through: the first started the room's playback, the other 9 are queued, and no refusal changed it.
    expect(watcher.sock.of("embed-changed", mark)).toHaveLength(1);
    expect(queueLengths(watcher.sock, mark).at(-1)).toBe(QUEUE_ADD_ROOM_BURST - 1);
    expect(Math.max(...queueLengths(watcher.sock, mark))).toBe(QUEUE_ADD_ROOM_BURST - 1);

    // D's refused tries were given back: once the room's bucket refills one, D adds again (their own bucket held 2).
    await sleep(QUEUE_ADD_ROOM_REFILL_MS + 300);
    expect(await addOne(d)).toEqual({ kind: "added" });
    // A is still dry: the member's bucket refills one per QUEUE_ADD_MEMBER_REFILL_MS, and the room's refill isn't A's.
    expect(await addOne(a)).toMatchObject({ kind: "refused", code: "rate_limited" });
    await settle(watcher);
    expect(queueLengths(watcher.sock, mark).at(-1)).toBe(QUEUE_ADD_ROOM_BURST);
  });
});

test.describe("queue-add URLs and frame shape (ADR 0031 §2, ADR 0024)", () => {
  /** Each member has QUEUE_ADD_MEMBER_BURST adds, so `urls` go out three to a member. All must be refused as `code`, with nothing stored or broadcast. */
  async function expectRefused(net: Net, room: Joinable, urls: readonly string[], code: ErrorCode, honestUrl = video(1)): Promise<void> {
    expect(urls.length, "the room's burst must cover every case").toBeLessThan(QUEUE_ADD_ROOM_BURST);
    const watcher = await net.join(room, { nickname: "watcher" });
    await settle(watcher);
    const mark = watcher.sock.frames.length;
    let member: Member | null = null;
    for (const [i, url] of urls.entries()) {
      if (i % QUEUE_ADD_MEMBER_BURST === 0) member = await net.join(room, { nickname: `adder-${String(i)}` });
      if (member === null) throw new Error("no member");
      const before = member.sock.frames.length;
      expect(await add(member, url), url.slice(0, 80)).toMatchObject({ kind: "refused", code });
      // Exactly the error came back to the sender.
      expect(member.sock.frames.slice(before).filter((f) => f.type !== "pong").map((f) => f.type)).toEqual(["error"]);
    }
    await settle(watcher);
    // Nothing was broadcast, and a late joiner finds no video and an empty queue.
    expect(watcher.sock.frames.slice(mark).filter((f) => f.type !== "pong" && f.type !== "member-joined" && f.type !== "member-left")).toEqual([]);
    const late = (await snapshotNow(net, room, "late-comer")).room;
    expect({ embed: late.embed ?? null, queue: late.queue ?? [] }).toEqual(ROOM_STATE_UNTOUCHED);
    // The room still takes an honest add.
    const honest = await net.join(room, { nickname: "honest" });
    expect(await add(honest, honestUrl)).toEqual({ kind: "added" });
  }

  test("unparsable and dangerous URLs (garbage, javascript:, data:, file:, http:, userinfo, XSS-shaped) are refused with unsupported_url", async ({ net }) => {
    await expectRefused(
      net,
      ownedRoom("abbad"),
      [
        "not a url",
        "",
        "javascript:alert(document.cookie)",
        "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
        "file:///etc/passwd",
        "http://example.com/video",
        "https://user:secret@example.com/video",
        `https://www.youtube.com/watch?v="><script>alert(1)</script>`,
        "//example.com/video",
      ],
      "unsupported_url",
    );
  });

  test("hosts the generic tier never takes (IP literals, localhost, private names, ports, the denylist) are refused with unsupported_url", async ({ net }) => {
    await expectRefused(
      net,
      ownedRoom("abhost"),
      [
        "https://127.0.0.1/video",
        "https://[::1]/video",
        "https://localhost/video",
        "https://printer.local/video",
        "https://intranet.internal/video",
        "https://example.com:8443/video",
        `https://${DENIED_DOMAIN}/video`,
        `https://sub.${DENIED_DOMAIN}/video`,
        "https://203.0.113.9/video",
      ],
      "unsupported_url",
      `https://not-${DENIED_DOMAIN}/video`,
    );
  });

  test("a public host outside the allowlist only ever becomes a generic, click-to-load embed; hostile characters never reach the wire; a 2048-char URL is refused", async ({ net }) => {
    const room = ownedRoom("abgen");
    const watcher = await net.join(room, { nickname: "watcher" });
    const m1 = await net.join(room, { nickname: "adder-one" });
    const m2 = await net.join(room, { nickname: "adder-two" });
    await settle(watcher);
    const mark = watcher.sock.frames.length;

    expect(await add(m1, "https://example.org/player?x=1")).toEqual({ kind: "added" });
    expect(await add(m1, "https://youtube.com.evil-embeds.org/watch?v=vid00000001")).toEqual({ kind: "added" });
    // The server parses the hostile path into a URL (the parser percent-encodes `"`, `<` and `>`); the raw string never travels.
    expect(await add(m1, `https://example.org/"><img src=x onerror=alert(1)>`)).toEqual({ kind: "added" });
    const longUrl = `https://example.org/${"a".repeat(MAX_URL_LENGTH - "https://example.org/".length)}`;
    expect(longUrl).toHaveLength(MAX_URL_LENGTH);
    expect(await add(m2, longUrl)).toMatchObject({ kind: "refused", code: "unsupported_url" });
    await settle(watcher);

    const started = watcher.sock.of("embed-changed", mark);
    expect(started).toHaveLength(1);
    // A generic embed is never synced: no playback state, click to load.
    expect(started[0]?.playback ?? null).toBeNull();
    const items = [started[0]?.embed, ...(watcher.sock.of("queue-changed", mark).at(-1)?.queue ?? []).map((i) => i.embed)];
    expect(items).toHaveLength(3);
    for (const embed of items) {
      expect(embed?.provider).toBe("generic");
      if (embed?.provider !== "generic") continue;
      const url = new URL(embed.url);
      expect(url.protocol).toBe("https:");
      expect(embed.url).not.toMatch(/[<>"]/);
      expect(embed.url).toBe(url.href);
    }
    expect(items.map((e) => (e?.provider === "generic" ? e.host : null))).toEqual(["example.org", "youtube.com.evil-embeds.org", "example.org"]);
    // No frame the server sent carries a raw tag.
    for (const text of [...watcher.sock.texts, ...m1.sock.texts]) expect(text).not.toContain("<img");
  });

  test("malformed frames (extra fields, wrong types, not JSON, binary, over MAX_URL_LENGTH) are rejected by the strict schema; 20 of them close the socket with 4400; an oversize frame closes it; the room is untouched", async ({ net }) => {
    const room = ownedRoom("abshape");
    const watcher = await net.join(room, { nickname: "watcher" });
    const attacker = await net.join(room, { nickname: "attacker" });
    await settle(watcher, attacker);
    const mark = watcher.sock.frames.length;

    const url = "https://www.youtube.com/watch?v=vid00000001";
    const shapes: unknown[] = [
      { type: "queue-add", url, extra: 1 },
      { type: "queue-add", url: 123 },
      { type: "queue-add" },
      { type: "queue-add", url: null },
      { type: "queue-add", url: [url] },
      { type: "queue-add", url: { href: url } },
      { type: "queue-add", url: `https://example.org/${"a".repeat(MAX_URL_LENGTH - "https://example.org/".length + 1)}` },
      { type: "queue-remove", itemId: 5 },
      { type: "queue-remove", itemId: "has space" },
      { type: "queue-advance" },
      { type: "ended", itemId: "item1", position: "3" },
      { type: "ended", itemId: "item1", position: -1 },
      { type: "ended", itemId: "item1", position: 1e9 },
      { type: "kick", memberId: "a b" },
      { type: "QUEUE-ADD", url },
    ];
    for (const frame of shapes) expect(await answer(attacker.sock, frame), JSON.stringify(frame).slice(0, 100)).toBe("bad_message");
    for (const text of ["{not json", "[]", "null", `"queue-add"`]) {
      const before = attacker.sock.frames.length;
      attacker.sock.sendText(text);
      await attacker.sock.waitFor(() => attacker.sock.of("error", before)[0], `bad_message for ${text}`);
      expect(attacker.sock.of("error", before).map((e) => e.code)).toEqual(["bad_message"]);
      await sleep(150);
    }
    expect(attacker.sock.closed, "19 bad frames leave the socket open").toBeNull();
    // A binary frame is not a text frame, so it's refused the same way (and is the 20th).
    attacker.sock.sendBinary(Buffer.from(JSON.stringify({ type: "queue-add", url })));
    expect((await attacker.sock.waitClosed()).code).toBe(CLOSE_CODES.BAD_MESSAGES);

    // A frame past MAX_CLIENT_MESSAGE_BYTES (4096) closes the socket outright: nothing is parsed, nothing relayed.
    const bystander = await net.join(room, { nickname: "bystander" });
    bystander.sock.sendText(JSON.stringify({ type: "queue-add", url: `https://example.org/${"a".repeat(5000)}` }));
    await bystander.sock.waitClosed();

    await settle(watcher);
    expect(watcher.sock.frames.slice(mark).filter((f) => f.type !== "pong" && f.type !== "member-joined" && f.type !== "member-left")).toEqual([]);
    const late = (await snapshotNow(net, room, "late-comer")).room;
    expect({ embed: late.embed ?? null, queue: late.queue ?? [] }).toEqual(ROOM_STATE_UNTOUCHED);
  });
});

test.describe("kick cooldown (ADR 0030 §2)", () => {
  test("a kicked member's brand-new socket from the same address is closed with 4005 before any snapshot; other addresses, the owner and other rooms are not", async ({ net }) => {
    const room = ownedRoom("abkick");
    const kickedAddr = net.freshAddr();
    const owner = await net.join(room, { nickname: "the-owner", as: "owner" });
    const kicked = await net.join(room, { nickname: "kicked-one", addr: kickedAddr });
    const bystander = await net.join(room, { nickname: "bystander" });
    await settle(owner, kicked, bystander);
    const kickedMark = kicked.sock.frames.length;
    const [ownerMark, bystanderMark] = [owner.sock.frames.length, bystander.sock.frames.length];

    owner.sock.send({ type: "kick", memberId: kicked.self });
    // The target hears nothing before the close, and everybody else is told why they left.
    expect((await kicked.sock.waitClosed()).code).toBe(CLOSE_CODES.KICKED);
    expect(kicked.sock.frames.length).toBe(kickedMark);
    for (const [heard, from] of [[owner, ownerMark], [bystander, bystanderMark]] as const) {
      const left = await heard.sock.waitFor(() => heard.sock.of("member-left", from).find((m) => m.memberId === kicked.self), "member-left");
      expect(left.reason).toBe("kicked");
    }
    // The member is gone: kicking again, or the owner kicking themselves, is a bad target.
    expect(await answer(owner.sock, { type: "kick", memberId: kicked.self })).toBe("bad_target");
    expect(await answer(owner.sock, { type: "kick", memberId: owner.self })).toBe("bad_target");

    // A fresh socket from the kicked address, under any name or secret that isn't the owner's: 4005, and no snapshot.
    for (const who of [
      { nickname: "kicked-one" },
      { nickname: "someone-else" },
      { nickname: "forger", as: "forged" as const },
    ]) {
      const again = await net.tryJoin(room, { ...who, addr: kickedAddr });
      const closed = await again.waitClosed();
      expect({ nickname: who.nickname, code: closed.code, reason: closed.reason }).toEqual({ nickname: who.nickname, code: CLOSE_CODES.KICKED, reason: "kicked" });
      expect(again.frames, "closed before any snapshot").toEqual([]);
    }

    // Not collateral: another address joins under the kicked name, the owner joins from the kicked address, and the same address joins another room.
    const elsewhere = await net.join(room, { nickname: "kicked-one" });
    expect(elsewhere.snapshot.room.members.map((m) => m.nickname)).toContain("kicked-one");
    const ownerAgain = await net.join(room, { nickname: "owner-again", as: "owner", addr: kickedAddr });
    expect(ownerAgain.owner).toBe(true);
    const lobby = await net.join({ id: DEFAULT_ROOM_ID }, { nickname: "kicked-one", addr: kickedAddr });
    expect(lobby.snapshot.self).toBeDefined();

    // KICK_COOLDOWN_MS is a constant (10 min) with no environment override, so the expiry can't be driven from here;
    // the wire carries no retry time either (the close reason is "kicked").
    test.info().annotations.push({ type: "cooldown expiry", description: "not covered: KICK_COOLDOWN_MS is 10 min and not configurable" });
  });
});

test.describe("stale ended reports (ADR 0031 §4)", () => {
  test("an ended for another item, an unknown id, a far-off position, from an unjoined socket or inside the debounce advances nothing; two members' ended for the same item advance once", async ({ net }) => {
    test.setTimeout(60_000);
    const room = ownedRoom("abended");
    const watcher = await net.join(room, { nickname: "watcher" });
    const a = await net.join(room, { nickname: "member-a" });
    const b = await net.join(room, { nickname: "member-b" });
    const outsider = await net.connect(room);
    await settle(watcher);

    // Three videos: the first starts the empty room's playback, the other two wait.
    for (const n of [1, 2, 3]) expect(await add(a, video(n))).toEqual({ kind: "added" });
    await settle(watcher);
    const startedAt = Date.now();
    const [first] = watcher.sock.of("embed-changed");
    const current = first?.itemId;
    const upcoming = watcher.sock.of("queue-changed").at(-1)?.queue.map((i) => i.id) ?? [];
    if (current === undefined || upcoming.length !== 2) throw new Error("expected a current item and two upcoming ones");
    const [second, third] = upcoming;
    if (second === undefined || third === undefined) throw new Error("expected two upcoming ids");
    const quiet = async (from: number, what: string): Promise<void> => {
      await settle(a, b, outsider, watcher);
      expect(watcher.sock.frames.slice(from).filter((f) => f.type !== "pong"), what).toEqual([]);
      for (const m of [a, b]) expect(m.sock.of("error"), what).toEqual([]);
      expect(outsider.of("error"), what).toEqual([]);
    };

    // Inside the debounce: the item has been current for well under QUEUE_ENDED_DEBOUNCE_MS.
    let mark = watcher.sock.frames.length;
    a.sock.send({ type: "ended", itemId: current, position: 0.1 });
    await quiet(mark, "an ended inside the debounce");
    expect(Date.now() - startedAt).toBeLessThan(QUEUE_ENDED_DEBOUNCE_MS);

    await sleep(Math.max(0, QUEUE_ENDED_DEBOUNCE_MS + 400 - (Date.now() - startedAt)));
    const position = (Date.now() - startedAt) / 1000;
    mark = watcher.sock.frames.length;
    // Past the debounce, but not valid: an upcoming item, an id nobody has, a position far from the room's clock, and no join.
    a.sock.send({ type: "ended", itemId: second, position });
    a.sock.send({ type: "ended", itemId: "no-such-item", position });
    b.sock.send({ type: "ended", itemId: current, position: 600 });
    b.sock.send({ type: "ended", itemId: current, position: 40_000 });
    outsider.send({ type: "ended", itemId: current, position });
    await quiet(mark, "stale and invalid ended reports");

    // Two members report the same end at once: the first advances, the second finds the item spent.
    mark = watcher.sock.frames.length;
    a.sock.send({ type: "ended", itemId: current, position: (Date.now() - startedAt) / 1000 });
    b.sock.send({ type: "ended", itemId: current, position: (Date.now() - startedAt) / 1000 });
    await settle(a, b, watcher);
    const advanced = watcher.sock.frames.slice(mark).filter((f) => f.type !== "pong");
    expect(advanced.map((f) => f.type)).toEqual(["embed-changed", "queue-changed"]);
    expect(watcher.sock.of("embed-changed", mark)[0]).toMatchObject({ itemId: second, by: null });
    expect(watcher.sock.of("queue-changed", mark)[0]?.queue.map((i) => i.id)).toEqual([third]);
    expect(watcher.sock.of("queue-changed", mark)[0]?.by).toBeNull();
    for (const m of [a, b]) expect(m.sock.of("error")).toEqual([]);

    // Replays: the spent item again, and the new current item inside its own debounce. Still one advance.
    mark = watcher.sock.frames.length;
    a.sock.send({ type: "ended", itemId: current, position });
    b.sock.send({ type: "ended", itemId: current, position });
    b.sock.send({ type: "ended", itemId: second, position: 0.2 });
    await quiet(mark, "replays after the advance");

    const late = (await snapshotNow(net, room, "late-comer")).room;
    expect(late.itemId).toBe(second);
    expect((late.queue ?? []).map((i) => i.id)).toEqual([third]);
  });
});
