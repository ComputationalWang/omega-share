// M7 report and takedown abuse suite (OME-602, ADR 0033): `POST /rooms/:id/report` and the operator's takedown, end to
// end against the real server. Hand-written HTTP and WebSocket clients, the way an attacker without our site would
// talk to it. Each case checks that the server answers with the documented status and code, stores nothing it was
// not meant to, leaks nothing, and stays healthy (a valid report still works afterwards, no thrown error in its output).
//
// Like the moderation and queue abuse suite it starts a server of its own per test (OMEGA_SERVER_PORT + 6): the e2e
// server runs without TRUST_PROXY, so every loopback client is unkeyed and skips the per-key report bucket and the
// duplicate check. This one trusts the rightmost X-Forwarded-For entry from a loopback peer (ADR 0015 §5), so each
// request picks the client key the server sees. It also has an operator socket (ADMIN_SOCKET in a temp dir), which is
// how the tests read the report queue (`GET /reports`) and take rooms down. The DB is the seeded e2e one
// (fixtures/seed-rooms.ts), fresh for every test, so spent buckets and takedowns never reach another test or a retry.
//
// The check order is body size -> room exists -> key bucket -> parse -> room bucket -> duplicate -> open cap -> store, so
// a malformed report still spends its key's token: every request below comes from an address of its own unless a case is
// about one key.
//
// The last case drives a real browser page: the site on the web port talks to the e2e server, so its WebSocket and HTTP
// requests are bridged to the server of this spec through Playwright routes.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { Agent, request, type IncomingHttpHeaders } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import * as v from "valibot";
import type { BrowserContext } from "@playwright/test";
import {
  CLOSE_CODES,
  REPORT_KEY_BURST,
  REPORT_KEY_REFILL_MS,
  REPORT_MAX_OPEN,
  REPORT_NOTE_MAX_LENGTH,
  REPORT_REASONS,
  REPORT_ROOM_BURST,
  ReportResponseSchema,
  type ReportResponse,
} from "@omega/shared";
import { expect, test as base } from "./support/csp";
import { PENDING, PORTS, ROOT, URLS, available } from "./support/apps";
import { ownedRoom } from "./support/owned-rooms";
import { joinRoom, leaveAll, testRoom, type Client } from "./support/room";
import { site } from "./support/selectors";
import { TEST_ROOM_IDS } from "./support/test-rooms";

// +6 is moderation-queue-abuse's server; the two run in parallel in a full suite.
const SERVER_PORT = PORTS.server + 8;
const SITE_ORIGIN = `http://localhost:${String(PORTS.web)}`;
/** A thrown error or an unhandled rejection in the server's output (not a log line that merely says "error"). */
const SERVER_FAULT = /\b(Error|TypeError|RangeError):|uncaught|unhandled/i;
/** The report body limit (packages/shared MAX_REPORT_BODY_BYTES), restated so a change to it fails here loudly. */
const BODY_LIMIT = 2048;

interface Reply {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly text: string;
}

interface Send {
  readonly method?: string;
  readonly path: string;
  readonly body?: string | Buffer;
  readonly headers?: Record<string, string>;
  /** Over the operator's Unix socket instead of TCP. */
  readonly socketPath?: string;
  /** No Content-Length: the body goes out chunked, so a size check on the header can't see it. */
  readonly chunked?: boolean;
}

const agent = new Agent({ keepAlive: true, maxSockets: 8 });

function send({ method = "GET", path, body, headers = {}, socketPath, chunked = false }: Send): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(body);
    const all: Record<string, string> = { ...headers };
    if (payload !== undefined && !chunked) all["content-length"] = String(payload.length);
    const req = request(
      socketPath === undefined
        ? { host: "127.0.0.1", port: SERVER_PORT, path, method, agent, headers: { host: `127.0.0.1:${String(SERVER_PORT)}`, ...all } }
        : { socketPath, path, method, agent: false, headers: all },
    );
    let answered = false;
    req.on("response", (res) => {
      answered = true;
      const parts: Buffer[] = [];
      res.on("data", (d: Buffer) => parts.push(d));
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(parts).toString("utf8") });
      });
    });
    req.on("error", (err) => {
      // The server may answer and hang up before it has read an oversized body.
      if (!answered) reject(err);
    });
    if (payload !== undefined) {
      if (chunked) for (let i = 0; i < payload.length; i += 1000) req.write(payload.subarray(i, i + 1000));
      else req.write(payload);
    }
    req.end();
  });
}

const parseJson = (text: string): unknown => JSON.parse(text);

/** The report endpoint's answer, parsed with the shared schema: anything else fails the test. */
function asReport(reply: Reply): ReportResponse {
  return v.parse(ReportResponseSchema, parseJson(reply.text));
}

function errorCode(reply: Reply): string | null {
  const r = asReport(reply);
  return r.ok ? null : r.error.code;
}

const ReportsListSchema = v.object({
  rooms: v.array(
    v.object({
      id: v.string(),
      state: v.picklist(["live", "taken_down", "gone"]),
      reports: v.array(v.object({ id: v.string(), reason: v.string(), note: v.nullable(v.string()), title: v.nullable(v.string()), embedUrl: v.nullable(v.string()) })),
    }),
  ),
});
type ReportQueue = v.InferOutput<typeof ReportsListSchema>;

interface Closed {
  readonly code: number;
  readonly reason: string;
}

/** A minimal WebSocket client on `node:http` (RFC 6455), so the test chooses the X-Forwarded-For key and sees the exact close code. */
class Sock {
  readonly texts: string[] = [];
  closed: Closed | null = null;
  onText: ((text: string) => void) | null = null;
  onClose: ((closed: Closed) => void) | null = null;
  readonly #socket: Socket;
  #buf: Buffer = Buffer.alloc(0);
  #parts: Buffer[] = [];

  private constructor(socket: Socket) {
    this.#socket = socket;
    socket.on("data", (chunk: Buffer) => {
      this.#feed(chunk);
    });
    socket.on("error", () => undefined);
    socket.on("close", () => {
      this.#finish({ code: 1006, reason: "" });
    });
  }

  static connect(path: string, addr: string): Promise<Sock> {
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
        const sock = new Sock(socket);
        if (head.length > 0) sock.#feed(head);
        resolve(sock);
      });
      req.on("response", (res) => {
        res.resume();
        reject(new Error(`upgrade refused: HTTP ${String(res.statusCode)}`));
      });
      req.on("error", reject);
      req.end();
    });
  }

  #finish(closed: Closed): void {
    if (this.closed !== null) return;
    this.closed = closed;
    this.onClose?.(closed);
  }

  #feed(chunk: Buffer): void {
    this.#buf = Buffer.concat([this.#buf, chunk]);
    for (;;) {
      const buf = this.#buf;
      if (buf.length < 2) return;
      const fin = (buf.readUInt8(0) & 0x80) !== 0;
      const opcode = buf.readUInt8(0) & 0x0f;
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
      if (buf.length < offset + length) return;
      const payload = buf.subarray(offset, offset + length);
      this.#buf = buf.subarray(offset + length);
      if (opcode === 0x8) {
        this.#finish({ code: payload.length >= 2 ? payload.readUInt16BE(0) : 1005, reason: payload.subarray(2).toString("utf8") });
        this.#write(0x8, payload.subarray(0, 2));
        this.#socket.end();
        return;
      }
      if (opcode === 0x9) {
        this.#write(0xa, payload);
        continue;
      }
      if (opcode !== 0x1 && opcode !== 0x0) continue;
      this.#parts.push(Buffer.from(payload));
      if (!fin) continue;
      const text = Buffer.concat(this.#parts).toString("utf8");
      this.#parts = [];
      this.texts.push(text);
      this.onText?.(text);
    }
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

  sendText(text: string): void {
    this.#write(0x1, Buffer.from(text, "utf8"));
  }

  close(code = 1000): void {
    this.#write(0x8, Buffer.from([code >> 8, code & 0xff]));
  }

  destroy(): void {
    this.#socket.destroy();
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

  waitClosed(ms = 5_000): Promise<Closed> {
    return this.waitFor(() => this.closed ?? undefined, "the socket to close", ms);
  }

  /** Whether a frame of this `type` has arrived. */
  has(type: string): boolean {
    return this.texts.some((t) => t.includes(`"type":"${type}"`));
  }
}

interface Fixture {
  readonly log: () => string;
  readonly socketPath: string;
  /** A client key no other request of this test has used. */
  readonly freshAddr: () => string;
  /** `POST /rooms/:id/report` from `addr` (a fresh key by default) with `body` (JSON-encoded unless it is a string). */
  readonly report: (roomId: string, body: unknown, opts?: { addr?: string; headers?: Record<string, string> }) => Promise<Reply>;
  readonly admin: (method: string, path: string) => Promise<Reply>;
  /** The operator's report queue (`GET /reports`). */
  readonly queue: () => Promise<ReportQueue>;
  readonly join: (roomId: string, inviteKey?: string) => Promise<Sock>;
}

const ROOM = ownedRoom("report");
const OTHER_ROOM = ownedRoom("abmod");

function startServer(): { fixture: Fixture; stop: () => Promise<void> } {
  const dir = mkdtempSync(join(tmpdir(), "omega-m7-report-abuse-"));
  const db = join(dir, "omega.db");
  const socketPath = join(dir, "admin.sock");
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
    ADMIN_SOCKET: socketPath,
  };
  let output = "";
  const child: ChildProcess = spawn("bun", ["apps/server/src/index.ts"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (d: Buffer) => (output += d.toString()));
  child.stderr?.on("data", (d: Buffer) => (output += d.toString()));
  let next = 1;
  const freshAddr = (): string => `198.18.${String(next >> 8)}.${String(next++ & 0xff)}`;
  const opened: Sock[] = [];
  const fixture: Fixture = {
    log: () => output,
    socketPath,
    freshAddr,
    report: (roomId, body, opts = {}) =>
      send({
        method: "POST",
        path: `/rooms/${roomId}/report`,
        body: typeof body === "string" ? body : JSON.stringify(body),
        headers: { "content-type": "application/json", "x-forwarded-for": opts.addr ?? freshAddr(), ...opts.headers },
      }),
    admin: (method, path) => send({ method, path, socketPath }),
    queue: async () => {
      const reply = await send({ method: "GET", path: "/reports", socketPath });
      expect(reply.status).toBe(200);
      return v.parse(ReportsListSchema, parseJson(reply.text));
    },
    join: async (roomId, inviteKey) => {
      const sock = await Sock.connect(`/rooms/${roomId}/ws`, freshAddr());
      opened.push(sock);
      sock.sendText(JSON.stringify({ type: "join", nickname: `m-${randomBytes(2).toString("hex")}`, avatar: 0, ...(inviteKey === undefined ? {} : { inviteKey }) }));
      return sock;
    },
  };
  return {
    fixture,
    stop: () =>
      new Promise((resolve) => {
        for (const s of opened) s.destroy();
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

const test = base.extend<{ server: Fixture }>({
  server: [
    async ({}, use) => {
      const { fixture, stop } = startServer();
      const line = `omega-share server on http://127.0.0.1:${String(SERVER_PORT)}/`;
      const deadline = Date.now() + 15_000;
      while (!fixture.log().includes(line)) {
        if (Date.now() > deadline) {
          await stop();
          throw new Error(`the server did not start on :${String(SERVER_PORT)}:\n${fixture.log()}`);
        }
        await sleep(100);
      }
      await use(fixture);
      const log = fixture.log();
      await stop();
      expect(log).not.toMatch(SERVER_FAULT);
    },
    { timeout: 60_000 },
  ],
});

test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);

const ROOM_ID_TOO_LONG = 40;
const spam = { reason: "spam" } as const;

/** The report count per room in the queue. */
const counts = (q: ReportQueue): Record<string, number> => Object.fromEntries(q.rooms.map((r) => [r.id, r.reports.length]));

test.describe("report floods (ADR 0033 §3)", () => {
  test("the same key: a repeat is already_reported (200) and stores nothing, then the key bucket refuses with rate_limited and Retry-After", async ({ server }) => {
    const addr = server.freshAddr();
    const first = await server.report(ROOM.id, { reason: "hate", note: "first" }, { addr });
    expect(first.status).toBe(202);
    expect(asReport(first)).toEqual({ ok: true, status: "received" });
    // The same key again: the duplicate answer, even with a different reason and note, and nothing new in the queue.
    const again = await server.report(ROOM.id, { reason: "violence", note: "second" }, { addr });
    expect(again.status).toBe(200);
    expect(asReport(again)).toEqual({ ok: true, status: "already_reported" });
    expect(counts(await server.queue())).toEqual({ [ROOM.id]: 1 });
    expect((await server.queue()).rooms[0]?.reports[0]?.note).toBe("first");

    // Every request that reaches the key bucket spends a token, the duplicate included: three in all, then refused.
    expect(REPORT_KEY_BURST).toBe(3);
    const third = await server.report(OTHER_ROOM.id, spam, { addr });
    expect(third.status).toBe(202);
    const refused = await server.report(ROOM.id, spam, { addr });
    expect(refused.status).toBe(429);
    const body = asReport(refused);
    expect(body.ok).toBe(false);
    if (body.ok) throw new Error("expected a refusal");
    expect(body.error.code).toBe("rate_limited");
    expect(body.error.retryAfterMs).toBeGreaterThanOrEqual(1000);
    expect(body.error.retryAfterMs).toBeLessThanOrEqual(REPORT_KEY_REFILL_MS);
    expect(refused.headers["retry-after"]).toBe(String(Math.ceil((body.error.retryAfterMs ?? 0) / 1000)));
    expect(refused.headers["cache-control"]).toBe("no-store");
    // Not stored, and not remembered against the room.
    expect(counts(await server.queue())).toEqual({ [ROOM.id]: 1, [OTHER_ROOM.id]: 1 });

    // The bucket is per key: another reporter is unaffected, and an unknown room is a 404 before the key bucket is looked at.
    expect((await server.report(ROOM.id, spam)).status).toBe(202);
    const unknown = await server.report("e2e-no-such-room", spam, { addr });
    expect(unknown.status).toBe(404);
    expect(errorCode(unknown)).toBe("room_not_found");
    expect(counts(await server.queue())).toEqual({ [ROOM.id]: 2, [OTHER_ROOM.id]: 1 });
  });

  test("the room bucket: REPORT_ROOM_BURST reporters at once, then rate_limited for everyone else, while other rooms still take reports", async ({ server }) => {
    for (let i = 0; i < REPORT_ROOM_BURST; i++) expect((await server.report(ROOM.id, spam)).status, `report ${String(i + 1)}`).toBe(202);
    const refused = await server.report(ROOM.id, { reason: "other", note: "one too many" });
    expect(refused.status).toBe(429);
    const body = asReport(refused);
    if (body.ok) throw new Error("expected a refusal");
    expect(body.error.code).toBe("rate_limited");
    expect(body.error.retryAfterMs).toBeGreaterThanOrEqual(1000);
    expect(body.error.retryAfterMs).toBeLessThanOrEqual(REPORT_KEY_REFILL_MS);
    expect(refused.headers["retry-after"]).toBe(String(Math.ceil((body.error.retryAfterMs ?? 0) / 1000)));
    // Exactly the burst was stored; the refused one left nothing, and the queue's note list holds none of its text.
    const q = await server.queue();
    expect(counts(q)).toEqual({ [ROOM.id]: REPORT_ROOM_BURST });
    expect(JSON.stringify(q)).not.toContain("one too many");
    // Another room has a bucket of its own.
    expect((await server.report(OTHER_ROOM.id, spam)).status).toBe(202);
  });

  test("the open cap: REPORT_MAX_OPEN open reports, then unavailable (503) with nothing stored; dismissing one makes room for one", async ({ server }) => {
    test.setTimeout(120_000);
    // 20 per room at most, so 50 rooms; the seeded rooms are plenty.
    const rooms = [...TEST_ROOM_IDS];
    expect(rooms.length * REPORT_ROOM_BURST).toBeGreaterThan(REPORT_MAX_OPEN);
    let sent = 0;
    for (const id of rooms) {
      for (let i = 0; i < REPORT_ROOM_BURST && sent < REPORT_MAX_OPEN; i++, sent++) {
        const reply = await server.report(id, spam);
        if (reply.status !== 202) throw new Error(`report ${String(sent + 1)} to ${id}: HTTP ${String(reply.status)} ${reply.text}`);
      }
      if (sent >= REPORT_MAX_OPEN) break;
    }
    expect(sent).toBe(REPORT_MAX_OPEN);
    const spare = rooms[rooms.length - 1] ?? "";
    const capped = await server.report(spare, { reason: "other", note: "past the cap" });
    expect(capped.status).toBe(503);
    expect(errorCode(capped)).toBe("unavailable");
    const full = await server.queue();
    expect(full.rooms.reduce((n, r) => n + r.reports.length, 0)).toBe(REPORT_MAX_OPEN);
    expect(JSON.stringify(full)).not.toContain("past the cap");

    // The operator clears one: the next report fits again, and the one after it doesn't.
    const victim = full.rooms[0]?.reports[0];
    if (victim === undefined) throw new Error("no report to dismiss");
    expect((await server.admin("POST", `/reports/${victim.id}/dismiss`)).status).toBe(200);
    expect((await server.report(spare, spam)).status).toBe(202);
    expect((await server.report(spare, spam)).status).toBe(503);
  });
});

test.describe("malformed reports (ADR 0033 §2)", () => {
  const long = "x".repeat(REPORT_NOTE_MAX_LENGTH + 1);

  const bad: readonly (readonly [string, unknown])[] = [
    ["invalid JSON", "{ not json"],
    ["an empty body", ""],
    ["JSON null", "null"],
    ["a JSON string", '"spam"'],
    ["a JSON array", '[{"reason":"spam"}]'],
    ["no reason", {}],
    ["an unknown reason", { reason: "porn" }],
    ["a reason of the wrong type", { reason: 3 }],
    ["a reason in the wrong case", { reason: "SPAM" }],
    ["an extra field", { reason: "spam", reporter: "me" }],
    ["an extra field that tries to name the reporter", { reason: "spam", key: "198.18.9.9", ip: "198.18.9.9" }],
    ["a note over the limit", { reason: "spam", note: long }],
    ["a note that is not a string", { reason: "spam", note: 5 }],
    ["a null note", { reason: "spam", note: null }],
    ["an object note", { reason: "spam", note: { text: "hi" } }],
    ["an empty note", { reason: "spam", note: "" }],
    ["a blank note", { reason: "spam", note: "   \n\t " }],
    ["a note of control characters", { reason: "spam", note: "bad\u0000note" }],
    ["a note longer than the raw cap even before line breaks collapse", { reason: "spam", note: "a\n".repeat(REPORT_NOTE_MAX_LENGTH + 1) }],
  ];

  test("every malformed body is refused with 400 invalid_body; nothing is stored and the server still takes a valid report", async ({ server }) => {
    for (const [what, body] of bad) {
      const reply = await server.report(ROOM.id, body);
      expect(reply.status, what).toBe(400);
      expect(errorCode(reply), what).toBe("invalid_body");
      expect(reply.headers["cache-control"], what).toBe("no-store");
    }
    expect((await server.queue()).rooms).toEqual([]);

    // Boundaries that are fine: a note of exactly the limit, and a note whose line breaks collapse into the limit.
    expect((await server.report(ROOM.id, { reason: "other", note: "y".repeat(REPORT_NOTE_MAX_LENGTH) })).status).toBe(202);
    expect((await server.report(ROOM.id, { reason: REPORT_REASONS[0] })).status).toBe(202);
    expect((await server.queue()).rooms[0]?.reports).toHaveLength(2);
  });

  test("an oversized body is refused with 413 payload_too_large, declared or chunked, and never parsed", async ({ server }) => {
    const huge = JSON.stringify({ reason: "spam", note: "z".repeat(BODY_LIMIT * 4) });
    const declared = await server.report(ROOM.id, huge);
    expect(declared.status).toBe(413);
    expect(errorCode(declared)).toBe("payload_too_large");
    // No Content-Length to check up front: the cap is enforced as the body is read.
    const chunked = await send({
      method: "POST",
      path: `/rooms/${ROOM.id}/report`,
      body: huge,
      chunked: true,
      headers: { "content-type": "application/json", "x-forwarded-for": server.freshAddr() },
    });
    expect(chunked.status).toBe(413);
    expect(errorCode(chunked)).toBe("payload_too_large");
    // Just over the limit with a valid prefix: refused too.
    const over = await server.report(ROOM.id, `{"reason":"spam","note":"${"q".repeat(BODY_LIMIT)}"}`);
    expect(over.status).toBe(413);
    expect((await server.queue()).rooms).toEqual([]);
    expect((await server.report(ROOM.id, spam)).status).toBe(202);
  });

  test("an unknown, malformed or oversized room id is 404 room_not_found and costs nobody a token", async ({ server }) => {
    const addr = server.freshAddr();
    const ids = ["nosuchroom", "e2e-report-nope", "UPPERCASE", "a".repeat(ROOM_ID_TOO_LONG), "x", "%00", "%E2%80%AE", "lobby%20", "..%2f..%2fetc"];
    for (const id of ids) {
      const reply = await server.report(id, spam, { addr });
      expect(reply.status, id).toBe(404);
      expect(errorCode(reply), id).toBe("room_not_found");
    }
    // The same key then still has its whole bucket.
    for (let i = 0; i < REPORT_KEY_BURST; i++) expect((await server.report(i === 0 ? ROOM.id : OTHER_ROOM.id, spam, { addr })).status).toBeLessThan(300);
    expect((await server.queue()).rooms).toHaveLength(2);
  });

  test("other methods and paths are refused (no 2xx, no report, no crash) and a non-JSON content type is 415 (OME-698)", async ({ server }) => {
    const path = `/rooms/${ROOM.id}/report`;
    const key = (): Record<string, string> => ({ "x-forwarded-for": server.freshAddr() });
    for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
      const reply = await send({ method, path, headers: key(), ...(method === "GET" ? {} : { body: JSON.stringify(spam) }) });
      expect(reply.status, method).toBeGreaterThanOrEqual(400);
      expect(reply.status, method).toBeLessThan(500);
      expect(reply.text, method).not.toContain('"received"');
    }
    for (const bad of [`/rooms/${ROOM.id}/report/`, `/rooms/${ROOM.id}/reports`, `/rooms/${ROOM.id}/report/extra`, `/rooms/report`]) {
      const reply = await send({ method: "POST", path: bad, body: JSON.stringify(spam), headers: { "content-type": "application/json", ...key() } });
      expect(reply.status, bad).toBeGreaterThanOrEqual(400);
      expect(reply.status, bad).toBeLessThan(500);
    }
    expect((await server.queue()).rooms).toEqual([]);

    // Anything but application/json is a CORS simple request a hostile page could send cross-site: 415 invalid_body,
    // even when the body is valid JSON, and nothing is stored (OME-698).
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"]) {
      const reply = await server.report(ROOM.id, JSON.stringify(spam), { headers: { "content-type": type } });
      expect(reply.status, type).toBe(415);
      expect(errorCode(reply), type).toBe("invalid_body");
    }
    expect((await server.queue()).rooms).toEqual([]);
    expect((await server.report(ROOM.id, spam, { headers: { "content-type": "Application/JSON; charset=utf-8" } })).status).toBe(202);
    expect(counts(await server.queue())).toEqual({ [ROOM.id]: 1 });
  });
});

test.describe("what an operator reads (ADR 0033 §3)", () => {
  test("emails, IP addresses and phone numbers in a note are redacted; a link to a video is kept; the reporter's key is never stored", async ({ server }) => {
    const notes: readonly (readonly [string, string])[] = [
      ["mail me at bob.smith@example.com now", "mail me at <email> now"],
      ["he lives at 203.0.113.7 and 2001:db8::1 too", "he lives at <ip> and <ip> too"],
      ["call +1 415 555 0132 or 415-555-0132 please", "call <phone> or <phone> please"],
      ["playing https://vimeo.com/76979871 and https://www.twitch.tv/videos/1234567890?t=1h2m3s", "playing https://vimeo.com/76979871 and https://www.twitch.tv/videos/1234567890?t=1h2m3s"],
      ["two\nlines\twith\r\nbreaks", "two lines with breaks"],
      ["  trimmed  ", "trimmed"],
    ];
    const addrs: string[] = [];
    for (const [note] of notes) {
      const addr = server.freshAddr();
      addrs.push(addr);
      expect((await server.report(ROOM.id, { reason: "other", note }, { addr })).status, note).toBe(202);
    }
    const q = await server.queue();
    const stored = q.rooms[0]?.reports.map((r) => r.note) ?? [];
    for (const [note, expected] of notes) expect(stored, note).toContain(expected);
    expect(stored).toHaveLength(notes.length);
    const dump = JSON.stringify(q);
    for (const secret of ["bob.smith", "203.0.113.7", "2001:db8", "415 555 0132", "415-555-0132"]) expect(dump, secret).not.toContain(secret);
    // Nothing about the reporters: not the addresses we reported from, nor the forwarded header's name.
    for (const addr of addrs) expect(dump, addr).not.toContain(addr);
    // What an operator needs to judge it: the room, the reason, and the title the room had.
    expect(q.rooms[0]).toMatchObject({ id: ROOM.id, state: "live" });
    expect(q.rooms[0]?.reports[0]).toMatchObject({ reason: "other", title: ROOM.title });
    // Reports are never logged (the server output is checked for faults at teardown; here for the notes too).
    expect(server.log()).not.toContain("bob.smith");
    expect(server.log()).not.toContain("203.0.113.7");
  });

  test("the operator socket is owner-only, and refuses what it should", async ({ server }) => {
    expect(statSync(server.socketPath).mode & 0o777).toBe(0o600);
    expect((await server.admin("GET", "/reports")).status).toBe(200);
    expect((await server.admin("POST", "/reports")).status).toBe(405);
    expect((await server.admin("GET", `/rooms/${ROOM.id}/takedown`)).status).toBe(405);
    expect((await server.admin("POST", "/rooms/not%20a%20room/takedown")).status).toBe(404);
    expect((await server.admin("POST", "/reports/not-a-report/dismiss")).status).toBe(404);
    expect((await server.admin("POST", "/reports/AAAAAAAAAAAAAAAAAAAAAA/dismiss")).status).toBe(404);
    // The report endpoint is not on the operator socket's paths for anyone on TCP: takedown is not reachable over TCP.
    const overTcp = await send({ method: "POST", path: `/rooms/${ROOM.id}/takedown`, headers: { "x-forwarded-for": server.freshAddr() } });
    expect(overTcp.status).toBeGreaterThanOrEqual(400);
    const live = await send({ method: "GET", path: `/rooms/${ROOM.id}`, headers: { "x-forwarded-for": server.freshAddr() } });
    expect(live.status).toBeLessThan(500);
    const stillThere = await server.join(ROOM.id, ROOM.inviteKey);
    await stillThere.waitFor(() => (stillThere.has("snapshot") ? true : undefined), "a snapshot: the room is still up");
    expect(stillThere.closed).toBeNull();
  });
});

test.describe("takedown (ADR 0033 §5)", () => {
  test("every member's socket closes with 4006, a rejoin is refused, the report is actioned, and the id stays dead", async ({ server }) => {
    const members = await Promise.all([server.join(ROOM.id, ROOM.inviteKey), server.join(ROOM.id, ROOM.inviteKey), server.join(ROOM.id, ROOM.inviteKey)]);
    for (const m of members) await m.waitFor(() => (m.has("snapshot") ? true : undefined), "a snapshot");
    // A bystander in another room must not be touched.
    const bystander = await server.join(OTHER_ROOM.id, OTHER_ROOM.inviteKey);
    await bystander.waitFor(() => (bystander.has("snapshot") ? true : undefined), "a snapshot");

    expect((await server.report(ROOM.id, { reason: "violence", note: "gore on the screen" })).status).toBe(202);
    expect((await server.report(OTHER_ROOM.id, spam)).status).toBe(202);
    const before = await server.queue();
    expect(before.rooms.find((r) => r.id === ROOM.id)).toMatchObject({ state: "live" });

    const taken = await server.admin("POST", `/rooms/${ROOM.id}/takedown`);
    expect(taken.status).toBe(200);
    expect(parseJson(taken.text)).toEqual({ takenDown: ROOM.id, live: true });
    for (const m of members) expect(await m.waitClosed()).toMatchObject({ code: CLOSE_CODES.TAKEN_DOWN });
    expect(bystander.closed).toBeNull();

    // Actioned: gone from the queue; the other room's report is still open.
    expect(counts(await server.queue())).toEqual({ [OTHER_ROOM.id]: 1 });

    // A rejoin: the upgrade is accepted, so the client hears the reason, and is closed 4006 before any snapshot or member list.
    const late = await server.join(ROOM.id, ROOM.inviteKey);
    expect(await late.waitClosed()).toMatchObject({ code: CLOSE_CODES.TAKEN_DOWN });
    expect(late.has("snapshot")).toBe(false);
    // Even with the owner's token (the owner has no way back in).
    const owner = await Sock.connect(`/rooms/${ROOM.id}/ws`, server.freshAddr());
    owner.sendText(JSON.stringify({ type: "join", nickname: "the-owner", avatar: 0, ownerToken: ROOM.ownerToken }));
    expect(await owner.waitClosed()).toMatchObject({ code: CLOSE_CODES.TAKEN_DOWN });
    expect(owner.has("snapshot")).toBe(false);
    owner.destroy();

    // It no longer answers as a room: reports are refused like any unknown room, and it is on no list.
    const after = await server.report(ROOM.id, spam);
    expect(after.status).toBe(404);
    expect(errorCode(after)).toBe("room_not_found");
    const rooms = await server.admin("GET", "/rooms");
    expect(rooms.text).not.toContain(ROOM.id);
    expect(rooms.text).toContain(OTHER_ROOM.id);
    const directory = await send({ method: "GET", path: "/rooms", headers: { "x-forwarded-for": server.freshAddr() } });
    expect(directory.text).not.toContain(ROOM.id);

    // Idempotent: a second takedown is not an error, finds nothing live, and brings nothing back; new rooms never take the id.
    const twice = await server.admin("POST", `/rooms/${ROOM.id}/takedown`);
    expect(twice.status).toBe(200);
    expect(parseJson(twice.text)).toEqual({ takenDown: ROOM.id, live: false });
    const created = await Promise.all(
      Array.from({ length: 2 }, async () => {
        const reply = await send({
          method: "POST",
          path: "/rooms",
          body: JSON.stringify({ title: "again", visibility: "public" }),
          headers: { "content-type": "application/json", "x-forwarded-for": server.freshAddr() },
        });
        return reply.text;
      }),
    );
    for (const text of created) expect(text).not.toContain(ROOM.id);
    expect(counts(await server.queue())).toEqual({ [OTHER_ROOM.id]: 1 });
    expect(bystander.closed).toBeNull();
  });
});

test.describe("takedown in a browser (ADR 0033 §6)", () => {
  let clients: Client[] = [];
  test.afterEach(async () => {
    await leaveAll(clients);
    clients = [];
  });

  /** Sends this context's site traffic to the spec's server: HTTP is re-fetched from it, each WebSocket is bridged to it. */
  async function bridge(context: BrowserContext, addr: string, sockets: Sock[]): Promise<void> {
    const web = new URL(URLS.server);
    await context.route(
      (url) => url.origin === web.origin && !url.pathname.endsWith("/ws"),
      async (route) => {
        const url = new URL(route.request().url());
        const response = await route.fetch({ url: `http://127.0.0.1:${String(SERVER_PORT)}${url.pathname}${url.search}`, headers: { ...route.request().headers(), "x-forwarded-for": addr } });
        await route.fulfill({ response });
      },
    );
    await context.routeWebSocket(/\/rooms\/[^/]+\/ws$/, (ws) => {
      const path = new URL(ws.url()).pathname;
      void Sock.connect(path, addr).then((sock) => {
        sockets.push(sock);
        sock.onText = (text) => {
          ws.send(text);
        };
        sock.onClose = (closed) => {
          void ws.close({ code: closed.code, reason: closed.reason });
        };
        ws.onMessage((m) => {
          if (typeof m === "string") sock.sendText(m);
        });
        ws.onClose(() => {
          sock.destroy();
        });
      });
    });
  }

  test("a guest reports the room from the page, the operator takes it down, and the page shows the notice and does not reconnect", async ({ browser, server }) => {
    const room = testRoom("report", "send");
    const sockets: Sock[] = [];
    clients = await joinRoom(browser, {
      roomUrl: room.url,
      count: 1,
      nicknamePrefix: "m7ra",
      setup: async (context) => {
        await bridge(context, server.freshAddr(), sockets);
      },
    });
    const page = clients[0]?.page;
    if (page === undefined) throw new Error("no client");
    await expect(page.locator(site.connectionStatus)).toHaveText("");
    expect(sockets).toHaveLength(1);
    // A second member on the raw side: it is closed too.
    const other = await server.join(room.id);
    await other.waitFor(() => (other.has("snapshot") ? true : undefined), "a snapshot");

    // The guest reports from the page: a real POST to the server of this spec.
    await page.locator(site.reportKey).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(site.reportDialog)).toBeVisible();
    await page.getByRole("radio", { name: "Spam or scams" }).check();
    await page.locator(site.reportSend).click();
    await expect.poll(async () => counts(await server.queue())[room.id] ?? 0).toBe(1);
    await page.keyboard.press("Escape");

    const taken = await server.admin("POST", `/rooms/${room.id}/takedown`);
    expect(taken.status).toBe(200);
    expect(parseJson(taken.text)).toEqual({ takenDown: room.id, live: true });

    const notice = page.locator(site.roomClosed);
    await expect(notice).toBeVisible();
    await expect(notice).toHaveAttribute("data-reason", "taken-down");
    await expect(notice).toContainText("This room was closed by the omega-share team after a report.");
    await expect(page.locator(site.reportKey)).toBeHidden();
    expect(await other.waitClosed()).toMatchObject({ code: CLOSE_CODES.TAKEN_DOWN });
    expect(sockets[0]?.closed).toMatchObject({ code: CLOSE_CODES.TAKEN_DOWN });
    // No reconnect storm: the page stays on the notice and opens no more sockets.
    await page.waitForTimeout(2000);
    expect(sockets).toHaveLength(1);
    await expect(notice).toBeVisible();
    expect(await server.queue()).toEqual({ rooms: [] });
  });
});
