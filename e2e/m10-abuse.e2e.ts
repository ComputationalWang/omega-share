// M10 abuse suite (OME-912, QA of the Q1 wave: durable sessions ADR 0043 / OME-908 + OME-911, room presets and saved
// layouts OME-909 + OME-910). Hand-crafted frames and requests, the way an attacker without our site would send them,
// asserting on the wire and on the server's state (what a fresh joiner's snapshot says), not only on the UI.
//
//  1. Resume tokens: forged, replayed and raced tokens, and the token never leaving its owner's frames or the log.
//  2. POST /rooms with bad preset ids and oversized bodies, and what rejected bodies cost against the creation limits.
//  3. A raw oversized or malformed `layout-set` from the owner, and garbage in the browser's saved-layouts key.
//
// Like moderation-queue-abuse.e2e.ts, the wire cases start a server of their own for each test (PORTS.server + 10)
// with TRUST_PROXY=loopback, so every socket and request picks the address the server keys it on (the shared e2e
// server keys every loopback client as one, which skips the per-address caps) and no test inherits another's spent
// limits. The server boots from the seeded DB (fixtures/seed-rooms.ts: private owned rooms with known secrets).
// RESUME_GRACE_MS is 6 s here (the server's floor is 5 s) so the hold's expiry is observable. The browser cases
// (section 3) own a server and a Vite site, like room-presets.e2e.ts, so a created room needs no shared rate limit.
import { spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import * as v from "valibot";
import {
  CreateRoomRequestSchema,
  MAX_CREATE_BODY_BYTES,
  RESUME_TOKEN_LENGTH,
  ROOM_PRESET_IDS,
  RoomLayoutInputSchema,
  RoomLayoutSchema,
  CLOSE_CODES,
  parseClientMessage,
  parseServerMessage,
  type MemberId,
  type ServerMessage,
} from "@omega/shared";
import { PORTS, ROOT } from "./support/apps";
import { expect, test as base, watchCsp } from "./support/csp";
import { stubExternalNetwork } from "./support/network";
import { ownedRoom } from "./support/owned-rooms";
import { signalOwned, spawnOwned } from "./support/owned";
import { site } from "./support/selectors";
import { openDirectory } from "./support/directory";
import { serverArgv } from "./support/server-cmd";

const SERVER_PORT = PORTS.server + 10;
const SERVER_URL = `http://127.0.0.1:${String(SERVER_PORT)}`;
/** The server's Prometheus text (METRICS_PORT, 127.0.0.1 only): `omega_rooms` counts every live room, listed or not. */
const METRICS_URL = `http://127.0.0.1:${String(SERVER_PORT + 1)}/metrics`;
const SITE_ORIGIN = `http://localhost:${String(PORTS.web)}`;
const GRACE_MS = 6_000;
/** A thrown error or an unhandled rejection in the server's output. */
const SERVER_FAULT = /\b(Error|TypeError|RangeError):|uncaught|unhandled/i;

type Of<T extends ServerMessage["type"]> = Extract<ServerMessage, { type: T }>;
interface Closed {
  readonly code: number;
  readonly reason: string;
}

/**
 * A WebSocket client written by hand on `node:http` (RFC 6455), so a case can send any bytes, any frame size and pick
 * the `X-Forwarded-For` address. Same as moderation-queue-abuse.e2e.ts, plus 64-bit lengths for oversized frames.
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
    else {
      head = Buffer.alloc(10);
      head.writeUInt8(0x80 | opcode, 0);
      head.writeUInt8(0x80 | 127, 1);
      head.writeBigUInt64BE(BigInt(n), 2);
    }
    const body = Buffer.alloc(n);
    for (let i = 0; i < n; i++) body.writeUInt8(payload.readUInt8(i) ^ mask.readUInt8(i % 4), i);
    this.#socket.write(Buffer.concat([head, mask, body]));
  }

  send(msg: unknown): void {
    this.sendText(JSON.stringify(msg));
  }

  sendText(text: string): void {
    this.#write(0x1, Buffer.from(text, "utf8"));
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

  /** Barrier: a `ping` and its `pong`. Everything the server did for the frames sent before arrives before the pong. */
  async sync(): Promise<void> {
    const id = ++this.#pings;
    this.send({ type: "ping", id });
    await this.waitFor(() => this.of("pong").find((p) => p.id === id), "a pong");
  }
}

interface Joinable {
  readonly id: string;
  readonly inviteKey: string;
  readonly ownerToken: string;
}

interface Member {
  readonly sock: RawSocket;
  readonly self: MemberId;
  readonly snapshot: Of<"snapshot">;
  /** The resume token the server minted (durable joins only). */
  readonly token: string;
  readonly shareToken: string;
}

interface Who {
  readonly nickname: string;
  readonly durable?: boolean;
  readonly owner?: boolean;
}

interface ServerFixture {
  readonly log: () => string;
}

interface Net {
  readonly freshAddr: () => string;
  readonly connect: (room: Joinable, addr?: string) => Promise<RawSocket>;
  readonly join: (room: Joinable, who: Who) => Promise<Member>;
}

const ROOM_A = ownedRoom("abforge");
const ROOM_B = ownedRoom("abcap");

const SERVER_ENV_UNSET = new Set(["PUBLIC_ORIGIN", "STATIC_DIR", "METRICS_PORT", "GENERIC_EMBEDS", "EXTENSION_IDS", "MAX_CONNECTIONS"]);

/** Output capture and orderly stop for a child process of the spec. */
class Proc {
  output = "";
  readonly child: ChildProcess;
  constructor(
    readonly port: number,
    command: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
  ) {
    this.child = spawnOwned(port, command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    this.child.stdout?.on("data", (d: Buffer) => (this.output += d.toString()));
    this.child.stderr?.on("data", (d: Buffer) => (this.output += d.toString()));
  }
  async waitFor(what: string, ready: () => boolean | Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (this.child.exitCode !== null) throw new Error(`${what} exited ${String(this.child.exitCode)}:\n${this.output}`);
      if (await ready()) return;
      await sleep(100);
    }
    await this.stop();
    throw new Error(`${what} not ready in 30 s:\n${this.output}`);
  }
  stop(): Promise<void> {
    const c = this.child;
    if (c.exitCode !== null || c.signalCode !== null || c.pid === undefined) return Promise.resolve();
    return new Promise((resolve) => {
      c.once("exit", () => {
        resolve();
      });
      signalOwned(c, this.port, "SIGKILL");
    });
  }
}

const cleanEnv = (): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(process.env).filter(([key]) => !SERVER_ENV_UNSET.has(key)));

/** A server on `port` booted from a seeded DB, trusting a loopback X-Forwarded-For. `site` is the origin it allows. */
async function startServer(port: number, siteOrigin: string, metricsPort: number | null = null): Promise<{ proc: Proc; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "omega-m10-abuse-"));
  const db = join(dir, "omega.db");
  const seeded = spawnSync("bun", ["e2e/fixtures/seed-rooms.ts", db], { cwd: ROOT, encoding: "utf8" });
  if (seeded.status !== 0) throw new Error(`seeding failed:\n${seeded.stdout}\n${seeded.stderr}`);
  const proc = new Proc(port, ...serverArgv(), ROOT, {
    ...cleanEnv(),
    PORT: String(port),
    HOST: "127.0.0.1",
    SITE_ORIGIN: siteOrigin,
    TRUST_PROXY: "loopback",
    DB_PATH: db,
    ADMIN_SOCKET: "off",
    RESUME_GRACE_MS: String(GRACE_MS),
    ...(metricsPort === null ? {} : { METRICS_PORT: String(metricsPort) }),
  });
  await proc.waitFor("server", () => proc.output.includes(`omega-share server on http://127.0.0.1:${String(port)}/`));
  return { proc, dir };
}

const test = base.extend<{ net: Net; server: ServerFixture }>({
  server: [
    async ({}, use) => {
      const { proc, dir } = await startServer(SERVER_PORT, SITE_ORIGIN, SERVER_PORT + 1);
      await use({ log: () => proc.output });
      await proc.stop();
      rmSync(dir, { recursive: true, force: true });
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
    const join: Net["join"] = async (room, who) => {
      const sock = await connect(room);
      sock.send({
        type: "join",
        nickname: who.nickname,
        avatar: 0,
        ...(who.owner === true ? { ownerToken: room.ownerToken } : { inviteKey: room.inviteKey }),
        ...(who.durable === true ? { durableSession: true } : {}),
      });
      const snapshot = await sock.waitFor(() => sock.of("snapshot")[0], `${who.nickname}'s snapshot`);
      return { sock, self: snapshot.self, snapshot, token: snapshot.resumeToken ?? "", shareToken: snapshot.shareToken ?? "" };
    };
    await use({ freshAddr, connect, join });
    for (const sock of opened) {
      expect(sock.unparsed, "every server frame parses with the shared schema").toEqual([]);
      sock.destroy();
    }
    expect(server.log()).not.toMatch(SERVER_FAULT);
  },
});

/** Member ids of `peek` probes: their join and leave are the test's own noise, not the room's. */
const probes = new Set<string>();

/** What a fresh joiner sees now. The probe leaves explicitly, so it never lingers. */
async function peek(net: Net, room: Joinable): Promise<Of<"snapshot">["room"]> {
  const probe = await net.join(room, { nickname: `peek${String(Math.floor(Math.random() * 1e6))}` });
  probes.add(probe.self);
  probe.sock.send({ type: "leave" });
  return probe.snapshot.room;
}

const isProbeNoise = (m: ServerMessage): boolean => (m.type === "member-joined" && probes.has(m.member.id)) || (m.type === "member-left" && probes.has(m.memberId));
/** What the room told this socket since `mark`, minus pongs and the test's own probes. */
const typesAfter = (sock: RawSocket, mark: number): string[] => sock.frames.slice(mark).filter((m) => m.type !== "pong" && !isProbeNoise(m)).map((m) => m.type);
const leftOf = (sock: RawSocket): Of<"member-left">[] => sock.of("member-left").filter((m) => !probes.has(m.memberId));
const joinedOf = (sock: RawSocket): Of<"member-joined">[] => sock.of("member-joined").filter((m) => !probes.has(m.member.id));

async function seat(m: Member, watcher: Member, index: number): Promise<void> {
  m.sock.send({ type: "sit", seat: index });
  await watcher.sock.waitFor(() => watcher.sock.of("seat-changed").find((s) => s.memberId === m.self && s.seat === index), `seat ${String(index)} to be taken`);
}

const seatOfIn = (room: Of<"snapshot">["room"], id: MemberId): number | null => {
  const i = room.seats.indexOf(id);
  return i < 0 ? null : i;
};

// ---------------------------------------------------------------------------------------------------------------
// 1. Resume tokens
// ---------------------------------------------------------------------------------------------------------------

const b64url = (n: number): string => randomBytes(n).toString("base64url");
const frameOf = (resumeToken: unknown, extra: Record<string, unknown> = {}): string => JSON.stringify({ type: "join", nickname: "mallory", avatar: 0, resumeToken, ...extra });

test.describe("resume tokens (ADR 0043)", () => {
  test("a forged token never gets someone else's seat or member id, and the seat holder is not displaced", async ({ net }) => {
    const ana = await net.join(ROOM_A, { nickname: "ana", durable: true });
    const obs = await net.join(ROOM_A, { nickname: "obs" });
    const other = await net.join(ROOM_B, { nickname: "bea", durable: true });
    expect(ana.token).toHaveLength(RESUME_TOKEN_LENGTH);
    await seat(ana, obs, 2);
    await ana.sock.sync();
    await obs.sock.sync();
    const [anaMark, obsMark] = [ana.sock.frames.length, obs.sock.frames.length];
    const membersBefore = (await peek(net, ROOM_A)).members.length;

    // Right shape (43 base64url chars) but not a token anyone holds, plus another room's real token (bea's, a live member of room B).
    const shaped = [b64url(32), "A".repeat(43), "_".repeat(43), "-".repeat(43), b64url(32).toUpperCase(), other.token, `${ana.token.slice(0, 42)}${ana.token.endsWith("A") ? "B" : "A"}`];
    const answers: string[] = [];
    for (const token of shaped) {
      const mallory = await net.connect(ROOM_A);
      mallory.sendText(frameOf(token));
      const err = await mallory.waitFor(() => mallory.of("error")[0], `an answer for ${token.slice(0, 6)}`);
      expect(err.code, token.slice(0, 6)).toBe("resume_expired");
      answers.push(err.message);
      await mallory.sync();
      // Not joined: no snapshot, no member, nothing from the room, and a later frame still says not_joined.
      expect(typesAfter(mallory, 0)).toEqual(["error"]);
      mallory.send({ type: "chat", text: "hi" });
      expect((await mallory.waitFor(() => mallory.of("error")[1], "not_joined")).code).toBe("not_joined");
    }
    // Same answer whichever way it was wrong (nothing to tell a guesser).
    expect(new Set(answers).size).toBe(1);

    // Wrong shapes and wrong types fail the contract (bad_message), also never a member.
    const malformed = [
      frameOf(b64url(31)),
      frameOf(`${b64url(32)}A`),
      frameOf(""),
      frameOf("!".repeat(43)),
      frameOf(`${"A".repeat(42)}=`),
      frameOf("A".repeat(1000)),
      frameOf(null),
      frameOf(0),
      frameOf([ana.token]),
      frameOf({ token: ana.token }),
      frameOf(ana.token, { durableSession: false }),
      frameOf(ana.token, { durableSession: "true" }),
      frameOf(ana.token, { memberId: ana.self }),
      `{"type":"join","nickname":"mallory","avatar":0,"resumeToken":"${ana.token}","__proto__":{"owner":true}}`,
      `{"type":"join","nickname":"mallory","avatar":0,"__proto__":{"resumeToken":"${ana.token}"}}`,
    ];
    for (const frame of malformed) {
      const mallory = await net.connect(ROOM_A);
      mallory.sendText(frame);
      const err = await mallory.waitFor(() => mallory.of("error")[0], `an answer for ${frame.slice(0, 60)}`);
      // The valid-token-plus-junk frames must be refused whole: they may not resume ana either.
      expect(err.code, frame.slice(0, 80)).toBe("bad_message");
      await mallory.sync();
      expect(typesAfter(mallory, 0)).toEqual(["error"]);
    }

    // A tokenless join under the held member's name is the ordinary refusal: the nickname is reserved to ana.
    const squatter = await net.connect(ROOM_A);
    squatter.send({ type: "join", nickname: "ana", avatar: 0, inviteKey: ROOM_A.inviteKey });
    expect((await squatter.waitFor(() => squatter.of("error")[0], "nickname_taken")).code).toBe("nickname_taken");

    // Nobody was displaced or told anything.
    await ana.sock.sync();
    await obs.sock.sync();
    expect(ana.sock.closed).toBeNull();
    expect(typesAfter(ana.sock, anaMark)).toEqual([]);
    expect(typesAfter(obs.sock, obsMark)).toEqual([]);
    const after = await peek(net, ROOM_A);
    expect(after.members.length).toBe(membersBefore);
    expect(seatOfIn(after, ana.self)).toBe(2);
    expect((await peek(net, ROOM_B)).members.map((m) => m.id)).toContain(other.self);

    // The real token still resumes the very same member, in the very same seat (the forged tries cost it nothing).
    ana.sock.destroy();
    await obs.sock.waitFor(() => obs.sock.of("member-presence").find((p) => p.memberId === ana.self && p.away), "ana away");
    const back = await net.connect(ROOM_A);
    back.sendText(frameOf(ana.token));
    const snap = await back.waitFor(() => back.of("snapshot")[0], "the resumed snapshot");
    expect(snap.self).toBe(ana.self);
    expect(snap.resumed).toBe(true);
    expect(seatOfIn(snap.room, ana.self)).toBe(2);
    expect(snap.owner).toBeUndefined();
  });

  test("a token is dead after an explicit leave, and the replay gets the same answer as a forgery", async ({ net }) => {
    const ana = await net.join(ROOM_A, { nickname: "ana", durable: true });
    const obs = await net.join(ROOM_A, { nickname: "obs" });
    await seat(ana, obs, 4);
    const forged = await net.connect(ROOM_A);
    forged.sendText(frameOf(b64url(32)));
    const forgedAnswer = (await forged.waitFor(() => forged.of("error")[0], "forged answer")).message;

    ana.sock.send({ type: "leave" });
    await obs.sock.waitFor(() => obs.sock.of("member-left").find((l) => l.memberId === ana.self), "ana's leave");
    // A leave is final at once, with no grace: seat free, name free.
    const room = await peek(net, ROOM_A);
    expect(room.members.map((m) => m.id)).not.toContain(ana.self);
    expect(room.seats[4]).toBeNull();

    const mark = obs.sock.frames.length;
    const replay = await net.connect(ROOM_A);
    replay.sendText(frameOf(ana.token));
    const err = await replay.waitFor(() => replay.of("error")[0], "replay answer");
    expect(err.code).toBe("resume_expired");
    expect(err.message).toBe(forgedAnswer);
    await replay.sync();
    expect(typesAfter(replay, 0)).toEqual(["error"]);
    await obs.sock.sync();
    expect(typesAfter(obs.sock, mark)).toEqual([]);
    expect(seatOfIn(await peek(net, ROOM_A), ana.self)).toBeNull();
    // Never a fresh member: the replayer is still not joined, and the name is free for an honest join.
    replay.send({ type: "sit", seat: 4 });
    expect((await replay.waitFor(() => replay.of("error")[1], "not_joined")).code).toBe("not_joined");
    const again = await net.join(ROOM_A, { nickname: "ana" });
    expect(again.self).not.toBe(ana.self);
  });

  test("a token is dead once the grace window ends: one leave line, the seat is free, the replay is refused", async ({ net }) => {
    test.setTimeout(60_000);
    const ana = await net.join(ROOM_A, { nickname: "ana", durable: true });
    const obs = await net.join(ROOM_A, { nickname: "obs" });
    await seat(ana, obs, 5);

    ana.sock.destroy();
    await obs.sock.waitFor(() => obs.sock.of("member-presence").find((p) => p.memberId === ana.self && p.away), "ana away");
    // Held: the seat and the member stay, and no leave has been published.
    expect(seatOfIn(await peek(net, ROOM_A), ana.self)).toBe(5);
    expect(leftOf(obs.sock)).toEqual([]);

    const left = await obs.sock.waitFor(() => obs.sock.of("member-left").find((l) => l.memberId === ana.self), "the hold to expire", GRACE_MS + 5_000);
    expect(left.reason).toBe("left");
    expect(seatOfIn(await peek(net, ROOM_A), ana.self)).toBeNull();

    const mark = obs.sock.frames.length;
    const replay = await net.connect(ROOM_A);
    replay.sendText(frameOf(ana.token));
    expect((await replay.waitFor(() => replay.of("error")[0], "replay answer")).code).toBe("resume_expired");
    await replay.sync();
    expect(typesAfter(replay, 0)).toEqual(["error"]);
    await obs.sock.sync();
    expect(typesAfter(obs.sock, mark)).toEqual([]);
    expect(leftOf(obs.sock)).toHaveLength(1);
    expect((await peek(net, ROOM_A)).members.map((m) => m.id)).not.toContain(ana.self);
  });

  test("one token used by two sockets at once: one member, one live socket, the other closed as replaced", async ({ net }) => {
    const ana = await net.join(ROOM_A, { nickname: "ana", durable: true });
    const obs = await net.join(ROOM_A, { nickname: "obs" });
    await seat(ana, obs, 1);
    const membersBefore = (await peek(net, ROOM_A)).members.length;
    let token = ana.token;
    let holder: RawSocket = ana.sock;

    for (let round = 0; round < 4; round++) {
      holder.destroy();
      const away = obs.sock.frames.length;
      await obs.sock.waitFor(() => obs.sock.of("member-presence", Math.max(0, away - 1)).find((p) => p.memberId === ana.self && p.away), `round ${String(round)}: away`);
      // Both sockets open and unjoined first, then both frames in one tick.
      const [s1, s2] = [await net.connect(ROOM_A), await net.connect(ROOM_A)];
      const mark = obs.sock.frames.length;
      s1.sendText(frameOf(token));
      s2.sendText(frameOf(token));
      await sleep(400);
      const closed = [s1, s2].filter((s) => s.closed !== null);
      const live = [s1, s2].filter((s) => s.closed === null);
      expect(live, `round ${String(round)}: exactly one socket keeps the identity`).toHaveLength(1);
      expect(closed[0]?.closed?.code, "the other is closed as replaced").toBe(CLOSE_CODES.SESSION_REPLACED);
      const winner = live[0];
      if (winner === undefined) throw new Error("no live socket");
      expect(winner.of("snapshot")[0]?.self).toBe(ana.self);
      // The loser, if it got a snapshot before being replaced, got the same member, never a second one.
      for (const s of [s1, s2]) for (const snap of s.of("snapshot")) expect(snap.self).toBe(ana.self);
      // The room hears one "back", no leave, no join.
      await obs.sock.sync();
      expect(typesAfter(obs.sock, mark)).toEqual(["member-presence"]);
      expect(obs.sock.of("member-presence", mark)[0]).toMatchObject({ memberId: ana.self, away: false });
      // The replaced socket's late close must not hold or end the member: it still answers, seated, not away.
      await winner.sync();
      const room = await peek(net, ROOM_A);
      expect(room.members.length).toBe(membersBefore);
      expect(seatOfIn(room, ana.self)).toBe(1);
      expect(room.members.find((m) => m.id === ana.self)?.away).not.toBe(true);
      token = winner.of("snapshot")[0]?.resumeToken ?? token;
      holder = winner;
    }
    expect(leftOf(obs.sock)).toEqual([]);
    expect(joinedOf(obs.sock)).toEqual([]);
  });

  test("the resume token is never in a frame a peer receives, nor in the server log", async ({ net, server }) => {
    const ana = await net.join(ROOM_A, { nickname: "ana", durable: true });
    const obs = await net.join(ROOM_A, { nickname: "obs" });
    const peer = await net.join(ROOM_A, { nickname: "peer", durable: true });
    // A control: the scan below finds the token where it is meant to be.
    expect(JSON.stringify(ana.snapshot)).toContain(ana.token);
    expect(ana.sock.texts.some((t) => t.includes(ana.token))).toBe(true);

    ana.sock.send({ type: "chat", text: "hello" });
    await seat(ana, obs, 3);
    ana.sock.send({ type: "presence", away: true });
    ana.sock.send({ type: "emote", kind: "wave" });
    await obs.sock.waitFor(() => obs.sock.of("member-presence").find((p) => p.memberId === ana.self && p.away), "away hint");
    // Drop, resume (the replaced-socket path too), drop again, resume, then leave: every transition a peer can see.
    ana.sock.destroy();
    const r1 = await net.connect(ROOM_A);
    r1.sendText(frameOf(ana.token));
    await r1.waitFor(() => r1.of("snapshot")[0], "resume 1");
    const r2 = await net.connect(ROOM_A);
    r2.sendText(frameOf(ana.token));
    await r2.waitFor(() => r2.of("snapshot")[0], "resume 2");
    expect(r1.closed ?? (await r1.waitClosed())).toMatchObject({ code: CLOSE_CODES.SESSION_REPLACED });
    r2.send({ type: "leave" });
    await obs.sock.waitFor(() => obs.sock.of("member-left").find((l) => l.memberId === ana.self), "ana's leave");
    const late = await net.join(ROOM_A, { nickname: "late", durable: true });
    await obs.sock.sync();
    await peer.sock.sync();

    for (const [who, sock] of [["obs", obs.sock], ["peer", peer.sock], ["late", late.sock]] as const) {
      const text = sock.texts.join("\n");
      expect(text.includes(ana.token), `${who} never sees ana's resume token`).toBe(false);
      expect(text.includes(ana.shareToken), `${who} never sees ana's share token`).toBe(false);
      expect(text.includes(peer.token) && who !== "peer", `${who} never sees peer's resume token`).toBe(false);
      expect(text.includes(obs.shareToken) && who !== "obs", `${who} never sees obs's share token`).toBe(false);
    }
    expect(obs.sock.texts.some((t) => t.includes("resumeToken")), "obs has no resumeToken field at all").toBe(false);
    expect(peer.sock.texts.filter((t) => t.includes("resumeToken")).length, "peer's only resumeToken is its own snapshot").toBe(1);
    // The server's stdout and stderr (a per-test server): neither secret appears, whatever it logs.
    for (const secret of [ana.token, ana.shareToken, peer.token, ROOM_A.inviteKey]) expect(server.log().includes(secret)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 2. POST /rooms: preset ids and oversized bodies
// ---------------------------------------------------------------------------------------------------------------

interface Reply {
  readonly status: number;
  readonly text: string;
  readonly retryAfter: string | null;
}

let postSeq = 0;
/** A POST /rooms from address `addr` (default: one nobody used yet). */
async function post(body: string, opts: { addr?: string; type?: string } = {}): Promise<Reply> {
  const addr = opts.addr ?? `198.19.${String(Math.floor(++postSeq / 250))}.${String((postSeq % 250) + 1)}`;
  try {
    const res = await fetch(`${SERVER_URL}/rooms`, {
      method: "POST",
      headers: { "content-type": opts.type ?? "application/json", "x-forwarded-for": addr, origin: SITE_ORIGIN },
      body,
    });
    return { status: res.status, text: await res.text(), retryAfter: res.headers.get("retry-after") };
  } catch {
    // The server answered 413 from the headers and hung up while a big body was still being sent: status 0 here.
    return { status: 0, text: "", retryAfter: null };
  }
}

/** A chunked POST with no Content-Length, so only the streaming cap can stop it. */
function postChunked(chunks: readonly string[], addr: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port: SERVER_PORT, path: "/rooms", method: "POST", agent: false, headers: { "content-type": "application/json", "x-forwarded-for": addr, origin: SITE_ORIGIN, "transfer-encoding": "chunked" } },
      (res) => {
        let text = "";
        res.on("data", (d: Buffer) => (text += d.toString()));
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, text, retryAfter: typeof res.headers["retry-after"] === "string" ? res.headers["retry-after"] : null });
        });
      },
    );
    req.on("error", reject);
    for (const c of chunks) req.write(c);
    req.end();
  });
}

const createBody = (preset: unknown, title = "abuse room"): string => JSON.stringify({ title, visibility: "public", preset });

/** Rooms alive on the per-test server (the list endpoint is capped and hides private and untitled rooms, so it can't prove "none created"). */
async function roomCount(): Promise<number> {
  const text = await (await fetch(METRICS_URL)).text();
  const m = /^omega_rooms (\d+)$/m.exec(text);
  if (m?.[1] === undefined) throw new Error(`no omega_rooms in metrics:\n${text.slice(0, 300)}`);
  return Number(m[1]);
}

test.describe("POST /rooms with a bad preset or an oversized body", () => {
  test("every unknown preset id is a 400 invalid_body: no room, no echo of the input, nothing leaked", async ({ server }) => {
    const bad: { label: string; preset: unknown }[] = [
      { label: "unknown", preset: "unknown" },
      { label: "Classic (case)", preset: "Classic" },
      { label: "CLASSIC", preset: "CLASSIC" },
      { label: "empty string", preset: "" },
      { label: "../classic", preset: "../classic" },
      { label: "trailing space", preset: "classic " },
      { label: "NUL suffix", preset: "classic\u0000" },
      { label: "null", preset: null },
      { label: "{}", preset: {} },
      { label: "[]", preset: [] },
      { label: '["classic"]', preset: ["classic"] },
      { label: "0", preset: 0 },
      { label: "true", preset: true },
      { label: "__proto__", preset: "__proto__" },
      { label: "constructor", preset: "constructor" },
      { label: "toString", preset: "toString" },
      { label: "1 kB string", preset: "x".repeat(900) },
    ];
    const before = await roomCount();
    for (const [i, { label, preset }] of bad.entries()) {
      const title = `preset-abuse-${String(i)}`;
      const r = await post(createBody(preset, title));
      expect(r.status, label).toBe(400);
      const body: unknown = JSON.parse(r.text);
      expect(body, label).toMatchObject({ ok: false, error: { code: "invalid_body" } });
      // Nothing of a created room, and the rejected value is not reflected back.
      expect(r.text, label).not.toMatch(/ownerToken|inviteKey|"room"/);
      if (typeof preset === "string" && preset.length > 3) expect(r.text.includes(preset), label).toBe(false);
      expect(r.text.length, label).toBeLessThan(300);
    }
    // Non-preset junk the strict schema must also refuse, including prototype keys and a duplicate key (JSON.parse keeps the last).
    const extras: Record<string, string> = {
      "__proto__ key": `{"title":"proto-abuse","visibility":"public","__proto__":{"preset":"cinema"}}`,
      "extra key": `{"title":"extra-abuse","visibility":"public","preset":"cinema","layout":{"furniture":[]}}`,
      "duplicate key, last wins": `{"title":"dup-abuse","visibility":"public","preset":"cinema","preset":"nope"}`,
      "array body": `[{"title":"arr-abuse","visibility":"public"}]`,
      "null body": "null",
      "not JSON": `{"title":"nojson-abuse"`,
    };
    for (const [label, body] of Object.entries(extras)) {
      const r = await post(body);
      expect(r.status, label).toBe(400);
      expect(r.text, label).not.toMatch(/ownerToken|inviteKey/);
    }
    expect(await roomCount(), "no room was created").toBe(before);
    expect(server.log()).not.toMatch(SERVER_FAULT);

    // Control: each real preset id still creates a room (the assertions above are not just a dead endpoint).
    const ok = await post(createBody("cinema", "preset-control"));
    expect(ok.status).toBe(201);
    expect(v.safeParse(CreateRoomRequestSchema, { title: "x", visibility: "public", preset: "cinema" }).success).toBe(true);
    expect(ROOM_PRESET_IDS).toContain("cinema");
    expect(await roomCount(), "the control did create one").toBe(before + 1);
  });

  test("a body over MAX_CREATE_BODY_BYTES is a 413, declared or chunked; 10 kB too; no room", async ({ server }) => {
    const before = await roomCount();
    const padded = (n: number): string => JSON.stringify({ title: "big-abuse", visibility: "public", preset: "classic", pad: "x".repeat(n) });
    const justOver = padded(MAX_CREATE_BODY_BYTES);
    expect(Buffer.byteLength(justOver)).toBeGreaterThan(MAX_CREATE_BODY_BYTES);
    for (const [label, body] of [
      ["just over the cap", justOver],
      ["10 kB preset string", createBody("p".repeat(10 * 1024), "big-abuse")],
      ["10 kB body", padded(10 * 1024)],
      ["1 MB body", padded(1024 * 1024)],
    ] as const) {
      const r = await post(body);
      // A 1 MB body may see the connection reset once the 413 is out: status 0, or a 413 whose body was cut off (OME-1017). Refused all the same.
      const cut = label === "1 MB body";
      expect(cut ? [413, 0] : [413], label).toContain(r.status);
      if (r.status === 413 && !(cut && r.text === "")) expect(JSON.parse(r.text), label).toMatchObject({ ok: false, error: { code: "payload_too_large" } });
      expect(r.text, label).not.toMatch(/ownerToken|inviteKey|"room"/);
    }
    // No Content-Length: the streaming reader enforces the cap too.
    const chunked = await postChunked(['{"title":"big-abuse","visibility":"public","pad":"', "x".repeat(2 * MAX_CREATE_BODY_BYTES), '"}'], "198.19.200.1");
    expect(chunked.status).toBe(413);
    // Wrong content type is refused before any limiter or body read.
    expect((await post(createBody("classic", "ct-abuse"), { type: "text/plain" })).status).toBe(415);
    expect(await roomCount()).toBe(before);
    expect(server.log()).not.toMatch(SERVER_FAULT);
  });

  test("rate limit: a rejected body costs its key one of 2 creates per 10 min, but never the server-wide bucket", async ({ server }) => {
    const before = await roomCount();
    const keyA = "198.19.201.1";
    // Two rejections (400, then 413) from one key spend its whole allowance (apps/server/src/http.ts takes `creates` before the body is read).
    expect((await post(createBody("nope"), { addr: keyA })).status).toBe(400);
    expect((await post(createBody("x".repeat(2000)), { addr: keyA })).status).toBe(413);
    const third = await post(createBody("classic", "limited-abuse"), { addr: keyA });
    expect(third.status, "the key is spent: even a valid create is refused").toBe(429);
    expect(JSON.parse(third.text)).toMatchObject({ ok: false, error: { code: "rate_limited" } });
    expect(Number(third.retryAfter)).toBeGreaterThan(0);
    expect(await roomCount(), "the 429 created nothing").toBe(before);

    // The wrong content type costs nothing (it is refused before the bucket).
    const keyB = "198.19.201.2";
    for (let i = 0; i < 4; i++) expect((await post("x", { addr: keyB, type: "text/plain" })).status).toBe(415);
    expect((await post(createBody("classic", "ct-ok-abuse"), { addr: keyB })).status).toBe(201);

    // 12 rejected bodies from 12 different keys are more than the global burst of 10: if they counted against it, the next valid create would be a 429.
    for (let i = 0; i < 12; i++) expect((await post(createBody(`nope${String(i)}`))).status).toBe(400);
    for (let i = 0; i < 3; i++) expect((await post(createBody("lounge", `after-rejects-${String(i)}`))).status, `valid create ${String(i)} after the rejects`).toBe(201);
    expect(server.log()).not.toMatch(SERVER_FAULT);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 3a. A raw layout-set from the owner
// ---------------------------------------------------------------------------------------------------------------

const presetFile = (id: string): unknown => JSON.parse(readFileSync(join(ROOT, "assets/presets", `${id}.json`), "utf8")) as unknown;
const presetInput = (id: string): v.InferOutput<typeof RoomLayoutInputSchema> => v.parse(RoomLayoutInputSchema, presetFile(id));
const classic = (): v.InferOutput<typeof RoomLayoutInputSchema> => presetInput("classic");

test.describe("layout-set from the owner", () => {
  test("oversized, malformed and out-of-range layouts are refused and the room's layout is unchanged", async ({ net }) => {
    const room = ownedRoom("abshape");
    const owner = await net.join(room, { nickname: "boss", owner: true });
    expect(owner.snapshot.owner).toBe(true);
    const obs = await net.join(room, { nickname: "obs" });
    const original = v.parse(RoomLayoutSchema, owner.snapshot.room.layout);
    const piece = (over: Record<string, unknown>) => ({ ...classic().furniture[2], ...over });
    const withPiece = (over: Record<string, unknown>) => ({ furniture: [...classic().furniture.slice(0, 2), piece(over), ...classic().furniture.slice(3)] });
    const nested = (depth: number): string => `${"[".repeat(depth)}${"]".repeat(depth)}`;
    const base = classic();
    const cases: Record<string, string> = {
      "unknown furniture kind": JSON.stringify({ type: "layout-set", layout: withPiece({ kind: "evil" }) }),
      "col past the floor": JSON.stringify({ type: "layout-set", layout: withPiece({ col: 10 }) }),
      "col far out of range": JSON.stringify({ type: "layout-set", layout: withPiece({ col: 1e9 }) }),
      "negative row": JSON.stringify({ type: "layout-set", layout: withPiece({ row: -1 }) }),
      "fractional col": JSON.stringify({ type: "layout-set", layout: withPiece({ col: 1.5 }) }),
      "string col": JSON.stringify({ type: "layout-set", layout: withPiece({ col: "3" }) }),
      "unknown facing": JSON.stringify({ type: "layout-set", layout: withPiece({ facing: "up" }) }),
      "unknown key on a piece": JSON.stringify({ type: "layout-set", layout: withPiece({ evil: 1 }) }),
      "unknown key on the layout": JSON.stringify({ type: "layout-set", layout: { ...base, evil: 1 } }),
      "unknown key on the frame": JSON.stringify({ type: "layout-set", layout: base, evil: 1 }),
      "__proto__ on the layout": `{"type":"layout-set","layout":{"furniture":${JSON.stringify(base.furniture)},"__proto__":{"furniture":[]}}}`,
      "__proto__ on a piece": `{"type":"layout-set","layout":{"furniture":[{"kind":"tv","col":0,"row":0,"facing":"se","__proto__":{"kind":"evil"}}]}}`,
      "constructor key": JSON.stringify({ type: "layout-set", layout: { ...base, constructor: { prototype: { x: 1 } } } }),
      "no furniture": JSON.stringify({ type: "layout-set", layout: { furniture: [] } }),
      "furniture not an array": JSON.stringify({ type: "layout-set", layout: { furniture: "tv" } }),
      "null layout": JSON.stringify({ type: "layout-set", layout: null }),
      "missing layout": JSON.stringify({ type: "layout-set" }),
      "two TVs": JSON.stringify({ type: "layout-set", layout: { furniture: [...base.furniture, { kind: "tv", col: 3, row: 0, facing: "se" }] } }),
      "33 pieces": JSON.stringify({ type: "layout-set", layout: { furniture: Array.from({ length: 33 }, () => base.furniture[2]) } }),
      "deeply nested junk in the layout": `{"type":"layout-set","layout":{"furniture":${nested(1500)}}}`,
      "deeply nested junk as the frame": nested(2000),
    };
    // 20 malformed frames close a socket (4400): spread the cases over sockets that are the owner's.
    let sock = owner.sock;
    let sent = 0;
    let rolls = 0;
    const mark = obs.sock.frames.length;
    for (const [label, frame] of Object.entries(cases)) {
      if (sent === 8) {
        sock = (await net.join(room, { nickname: `boss${String(++rolls)}`, owner: true })).sock;
        sent = 0;
      }
      sent++;
      const at = sock.frames.length;
      sock.sendText(frame);
      const err = await sock.waitFor(() => sock.of("error", at)[0], `an error for ${label}`);
      expect(err.code, label).toBe("bad_message");
      await sleep(120);
    }
    // 1 MB: past the 4 kB frame cap, the server drops the socket (Bun answers 1009) before parsing a byte of it.
    const huge = await net.connect(room);
    huge.send({ type: "join", nickname: "huge", avatar: 0, ownerToken: room.ownerToken });
    await huge.waitFor(() => huge.of("snapshot")[0], "huge's snapshot");
    huge.sendText(JSON.stringify({ type: "layout-set", layout: { furniture: Array.from({ length: 20_000 }, () => base.furniture[2]) } }));
    const closed = await huge.waitClosed();
    expect([1009, 1006]).toContain(closed.code);
    // The whole room is unchanged and nobody was told anything.
    await obs.sock.sync();
    expect(obs.sock.of("layout-changed", mark)).toEqual([]);
    expect(typesAfter(obs.sock, mark).filter((t) => t !== "member-joined" && t !== "member-left")).toEqual([]);
    expect(v.parse(RoomLayoutSchema, (await peek(net, room)).layout)).toEqual(original);

    // Control: a valid layout is accepted, broadcast once, and a fresh joiner sees it (the refusals above are not a dead handler).
    const next = presetInput("lounge");
    expect(next).not.toEqual(original);
    const mark2 = obs.sock.frames.length;
    owner.sock.send({ type: "layout-set", layout: next });
    await obs.sock.waitFor(() => obs.sock.of("layout-changed", mark2)[0], "layout-changed");
    expect(v.parse(RoomLayoutSchema, (await peek(net, room)).layout)).toEqual(v.parse(RoomLayoutSchema, next));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 3b. Garbage in the browser's saved-layouts key
// ---------------------------------------------------------------------------------------------------------------

const SAVED_KEY = "omega.savedLayouts.v1";
const WEB_PORT = PORTS.fixtures + 23;
const WEB_SERVER_PORT = PORTS.fixtures + 22;
const WEB_URL = `http://localhost:${String(WEB_PORT)}`;
const WEB_SERVER_URL = `http://localhost:${String(WEB_SERVER_PORT)}`;
const id = (name: string): string => `[data-testid="${name}"]`;

const ALL_PRESETS = ROOM_PRESET_IDS.map((p) => ({ id: p, layout: v.parse(RoomLayoutSchema, presetFile(p)) }));
const entry = (name: string, layout: unknown = ALL_PRESETS[0]?.layout): { name: string; layout: unknown } => ({ name, layout });
/** Eight valid entries with distinct names; the picker may show the first five. */
const EIGHT = Array.from({ length: 8 }, (_, i) => entry(`Layout ${String(i + 1)}`, ALL_PRESETS[i % ALL_PRESETS.length]?.layout));
const withPiece = (over: Record<string, unknown>): unknown => {
  const l = ALL_PRESETS[0]?.layout;
  if (l === undefined) throw new Error("no classic preset");
  return { furniture: l.furniture.map((f, i) => (i === 2 ? { ...f, ...over } : f)) };
};
const deep = (depth: number, leaf: string): string => `${'{"a":'.repeat(depth)}${leaf}${"}".repeat(depth)}`;

interface Saved {
  readonly label: string;
  /** The raw string put in localStorage. */
  readonly raw: string;
  /** Names the picker may list, in order. */
  readonly names: readonly string[];
  /** The layout a valid entry must reach the server as (after the picker choice), if one is chosen. */
  readonly choose?: string;
  /** Junk that must appear in no byte sent to the server. */
  readonly junk: readonly string[];
  /** Render and picker only: the server-wide create bucket (10 per minute) is for the cases that reach the wire. */
  readonly noCreate?: true;
}

const GOOD = entry("Good", ALL_PRESETS[1]?.layout);
const goodLayout = ALL_PRESETS[1]?.layout;

const SAVED: readonly Saved[] = [
  { label: "more than 5 valid entries", raw: JSON.stringify(EIGHT), names: ["Layout 1", "Layout 2", "Layout 3", "Layout 4", "Layout 5"], choose: "Layout 5", junk: ["Layout 6", "Layout 8"] },
  {
    label: "a 1 MB entry (20 000 pieces) among valid ones",
    raw: JSON.stringify([entry("Huge", { furniture: Array.from({ length: 20_000 }, () => ({ kind: "plant", col: 0, row: 9, facing: "se" })) }), GOOD]),
    names: ["Good"],
    choose: "Good",
    junk: ["Huge", "plant"],
  },
  { label: "a 1 MB name", raw: JSON.stringify([entry("n".repeat(1_000_000)), GOOD]), names: ["Good"], junk: ["nnnnnnnnnn"], noCreate: true },
  { label: "a 1 MB junk key on an otherwise valid entry", raw: JSON.stringify([{ ...GOOD, evil: "e".repeat(1_000_000) }]), names: ["Good"], junk: ["eeeeeeeeee", '"evil"'], noCreate: true },
  { label: "deeply nested junk (100 000 levels, not JSON-parseable)", raw: `${"[".repeat(100_000)}${"]".repeat(100_000)}`, names: [], junk: [], noCreate: true },
  { label: "deeply nested junk inside an entry", raw: `[{"name":"Deep","layout":${deep(5_000, "1")}},${JSON.stringify(GOOD)}]`, names: ["Good"], choose: "Good", junk: ["Deep", '"a"'] },
  {
    label: "out-of-range and unknown furniture and tiles",
    raw: JSON.stringify([
      entry("Kind", withPiece({ kind: "evil" })),
      entry("Col", withPiece({ col: 99 })),
      entry("Neg", withPiece({ row: -1 })),
      entry("Frac", withPiece({ col: 1.5 })),
      entry("Face", withPiece({ facing: "up" })),
      entry("Variant", withPiece({ variant: 99 })),
      entry("Empty", { furniture: [] }),
      entry("", ALL_PRESETS[0]?.layout),
      { name: "NoLayout" },
      { layout: ALL_PRESETS[0]?.layout },
      "just a string",
      null,
      7,
    ]),
    names: [],
    junk: [],
  },
  {
    label: "a valid entry with unknown keys on the layout and its pieces: they are stripped before the server sees them",
    raw: JSON.stringify([{ name: "Extra", evil: 1, layout: { ...goodLayout, evilLayoutKey: 2, furniture: goodLayout?.furniture.map((f) => ({ ...f, evilPieceKey: 3 })) } }]),
    names: ["Extra"],
    choose: "Extra",
    junk: ["evil"],
  },
  {
    label: "prototype pollution keys",
    raw: `[{"name":"Proto","__proto__":{"polluted":"yes"},"layout":{"__proto__":{"polluted":"yes"},"furniture":${JSON.stringify(goodLayout?.furniture)}}},{"__proto__":{"polluted":"yes"},"name":"Second","constructor":{"prototype":{"polluted":"yes"}},"layout":${JSON.stringify(goodLayout)}}]`,
    names: ["Proto", "Second"],
    choose: "Second",
    junk: ["polluted", "__proto__", "constructor"],
  },
  { label: "a top-level __proto__ object, not a list", raw: `{"__proto__":{"polluted":"yes"},"0":${JSON.stringify(GOOD)}}`, names: [], junk: [], noCreate: true },
  { label: "duplicate names: the first wins, the rest are dropped", raw: JSON.stringify([entry("Same", ALL_PRESETS[2]?.layout), entry("Same", ALL_PRESETS[3]?.layout)]), names: ["Same"], choose: "Same", junk: [] },
];

test.describe("saved layouts: garbage in localStorage (own server and site)", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(90_000);

  let dir = "";
  let server: Proc | undefined;
  let web: Proc | undefined;
  let contexts: BrowserContext[] = [];
  let nextAddr = 1;

  test.beforeAll(async () => {
    const started = await startServer(WEB_SERVER_PORT, WEB_URL);
    dir = started.dir;
    server = started.proc;
    const w = new Proc(WEB_PORT, "bunx", ["vite", "--port", String(WEB_PORT), "--strictPort", "--host", "localhost"], join(ROOT, "apps/web"), { ...cleanEnv(), VITE_SERVER_URL: WEB_SERVER_URL });
    web = w;
    await w.waitFor("vite", async () => (await fetch(WEB_URL).then((r) => r.ok, () => false)) && w.output.includes(String(WEB_PORT)));
  });

  test.afterAll(async () => {
    await Promise.all([server?.stop(), web?.stop()]);
    rmSync(dir, { recursive: true, force: true });
  });

  test.afterEach(async () => {
    await Promise.all(contexts.map((c) => c.close()));
    contexts = [];
  });

  interface Sent {
    readonly page: Page;
    readonly errors: string[];
    /** Text frames this page sent on room sockets. */
    readonly frames: string[];
    /** Every request body sent to the server over HTTP. */
    readonly bodies: string[];
  }

  async function newPage(browser: Browser, raw: string): Promise<Sent> {
    const context = await watchCsp(await browser.newContext());
    contexts.push(context);
    await stubExternalNetwork(context);
    await context.addInitScript(
      ([origin, key, value]) => {
        if (location.origin === origin && localStorage.getItem(key ?? "") === null) localStorage.setItem(key ?? "", value ?? "");
      },
      [WEB_URL, SAVED_KEY, raw],
    );
    // Each room creation comes from an address of its own (the server trusts a loopback X-Forwarded-For).
    await context.route(`${WEB_SERVER_URL}/rooms`, async (route) => {
      const req = route.request();
      if (req.method() !== "POST") return route.fallback();
      const n = nextAddr++;
      return route.continue({ headers: { ...req.headers(), "x-forwarded-for": `198.18.${String(n >> 8)}.${String(n & 0xff)}` } });
    });
    const page = await context.newPage();
    const out: Sent = { page, errors: [], frames: [], bodies: [] };
    page.on("pageerror", (e) => out.errors.push(e.message));
    page.on("request", (r) => {
      if (r.url().startsWith(WEB_SERVER_URL) && r.method() !== "GET" && r.method() !== "OPTIONS") out.bodies.push(r.postData() ?? "");
    });
    page.on("websocket", (ws) => {
      if (!ws.url().startsWith(WEB_SERVER_URL.replace(/^http/, "ws"))) return;
      ws.on("framesent", (f) => {
        if (typeof f.payload === "string") out.frames.push(f.payload);
      });
    });
    return out;
  }

  const layoutOf = (page: Page): Promise<unknown> =>
    page.evaluate(() => {
      const debug: unknown = Reflect.get(window, "__omega");
      const room: unknown = typeof debug === "object" && debug !== null ? Reflect.get(debug, "room") : null;
      if (typeof room !== "object" || room === null) return null;
      const state: unknown = Reflect.get(room, "state");
      const s: unknown = typeof state === "function" ? Reflect.apply(state, room, []) : null;
      const r: unknown = typeof s === "object" && s !== null ? Reflect.get(s, "room") : null;
      return typeof r === "object" && r !== null ? (Reflect.get(r, "layout") as unknown) : null;
    });

  for (const c of SAVED) {
    test(`${c.label}: the home page renders, the picker lists only valid entries (max 5), a room can be created, nothing invalid reaches the server`, async ({ browser }) => {
      const s = await newPage(browser, c.raw);
      await s.page.goto(`${WEB_URL}/`);
      await openDirectory(s.page);
      await expect(s.page.locator(id("preset-classic"))).toBeChecked();
      const listed = s.page.locator(`${id("saved-layout")} .saved-name span`);
      await expect(listed).toHaveText([...c.names]);
      expect(await s.page.locator(id("saved-layout-radio")).count()).toBeLessThanOrEqual(5);
      // Prototypes are untouched, in this page and in what was stored.
      expect(await s.page.evaluate(() => Reflect.get({}, "polluted") === undefined && Reflect.get(Object.prototype, "polluted") === undefined)).toBe(true);

      if (c.noCreate === true) {
        expect(s.bodies).toEqual([]);
        expect(s.frames).toEqual([]);
        expect(s.errors).toEqual([]);
        return;
      }
      if (c.choose !== undefined) await s.page.locator(`${id("saved-layout")}:has-text("${c.choose}") ${id("saved-layout-radio")}`).check();
      await s.page.locator(site.createRoomTitle).fill("Abuse room");
      await s.page.locator(site.createRoomSubmit).click();
      await s.page.waitForURL(/\/r\/[a-z2-7]{26}$/);
      // The creator goes straight in with the saved profile (OME-2075).
      await expect(s.page.locator(site.room)).toBeVisible();

      const chosen = c.choose === undefined ? null : ALL_PRESETS.find((p) => JSON.stringify(p.layout) === JSON.stringify(wantedLayout(c)));
      if (chosen !== undefined && chosen !== null) await expect.poll(() => layoutOf(s.page).then((l) => JSON.stringify(l))).toBe(JSON.stringify(chosen.layout));
      else await s.page.waitForTimeout(500);

      // The wire: every HTTP body parses as a create request, every frame as a client message, every layout-set is strict-valid and is the chosen layout.
      expect(s.bodies.length).toBeGreaterThan(0);
      for (const body of s.bodies) expect(v.safeParse(CreateRoomRequestSchema, JSON.parse(body)).success, body.slice(0, 80)).toBe(true);
      expect(JSON.parse(s.bodies[0] ?? "null")).toMatchObject({ preset: c.choose === undefined ? "classic" : "empty" });
      const sets = s.frames.map((f) => parseClientMessage(f)).flatMap((m) => (m !== null && m.type === "layout-set" ? [m.layout] : []));
      for (const f of s.frames) expect(parseClientMessage(f), f.slice(0, 80)).not.toBeNull();
      expect(sets.length).toBe(chosen === undefined || chosen === null ? 0 : 1);
      for (const layout of sets) expect(JSON.stringify(layout)).toBe(JSON.stringify(chosen?.layout));
      for (const junk of c.junk) {
        for (const sent of [...s.bodies, ...s.frames]) expect(sent.includes(junk), `"${junk}" in ${sent.slice(0, 60)}`).toBe(false);
      }
      expect(s.errors).toEqual([]);
    });
  }

  /** The layout the named entry should reach the server as: its parsed form, unknown keys stripped. */
  function wantedLayout(c: Saved): unknown {
    const list: unknown = JSON.parse(c.raw);
    const found = Array.isArray(list) ? (list as unknown[]).find((e) => typeof e === "object" && e !== null && Reflect.get(e, "name") === c.choose) : undefined;
    const parsed = v.safeParse(RoomLayoutSchema, found === undefined ? null : Reflect.get(found as object, "layout"));
    return parsed.success ? parsed.output : null;
  }

  test("a saved entry deleted behind the picker's back is refused, not sent", async ({ browser }) => {
    const s = await newPage(browser, JSON.stringify([GOOD]));
    await s.page.goto(`${WEB_URL}/`);
    await openDirectory(s.page);
    await s.page.locator(id("saved-layout-radio")).check();
    await s.page.evaluate((key) => {
      localStorage.setItem(key, "{\"__proto__\":{\"polluted\":1}}");
    }, SAVED_KEY);
    await s.page.locator(site.createRoomTitle).fill("Gone");
    await s.page.locator(site.createRoomSubmit).click();
    await expect(s.page.locator(site.createRoomForm)).toBeVisible();
    await expect(s.page.locator(site.createRoomSubmit)).toBeEnabled();
    expect(s.bodies).toEqual([]);
    expect(s.page.url()).toBe(`${WEB_URL}/`);
    expect(s.errors).toEqual([]);
  });
});

