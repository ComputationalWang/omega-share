import { afterEach, describe, expect, test } from "bun:test";
import { connect, type Socket } from "node:net";
import * as v from "valibot";
import { CLOSE_CODES, MAX_CLIENT_MESSAGE_BYTES, ShareResponseSchema } from "@omega/shared";
import { measureRelayLatency } from "../src/relay-latency";
import { securityHeaders } from "../src/headers";
import { RoomRegistry } from "../src/rooms";
import { createWs } from "../src/ws";
import { Client, postShare, start, tokenOf, type TestServer } from "./helpers";

let t: TestServer | undefined;
const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await t?.server.stop(true);
});

async function join(server: TestServer, nickname: string) {
  const r = await Client.join(server.ws(), nickname);
  clients.push(r.client);
  return r;
}
async function open(url: string) {
  const c = await Client.open(url);
  clients.push(c);
  return c;
}

describe("abuse limits", () => {
  test("[Ad hoc close codes] a socket that never joins is closed after the join timeout", async () => {
    t = start({ joinTimeoutMs: 100 });
    const idle = await open(t.ws());
    const joined = await open(t.ws());
    joined.send({ type: "join", nickname: "alice", avatar: 0 });
    await joined.next("snapshot");
    const ev = await idle.closed;
    expect(ev.code).toBe(CLOSE_CODES.JOIN_TIMEOUT);
    await Bun.sleep(100);
    expect(joined.socket.readyState).toBe(WebSocket.OPEN);
  });

  test("leaving re-arms the join timeout", async () => {
    t = start({ joinTimeoutMs: 100 });
    const c = await open(t.ws());
    c.send({ type: "join", nickname: "alice", avatar: 0 });
    await c.next("snapshot");
    await Bun.sleep(150);
    expect(c.socket.readyState).toBe(WebSocket.OPEN);
    c.send({ type: "leave" });
    expect((await c.closed).code).toBe(CLOSE_CODES.JOIN_TIMEOUT);
  });

  test("a flooder gets one rate_limited notice per streak, not one per dropped frame", async () => {
    t = start();
    const a = await Client.join(t.ws(), "alice");
    clients.push(a.client);
    for (let i = 0; i < 100; i++) a.client.send({ type: "chat", text: `spam ${String(i)}` });
    await a.client.next("error");
    await a.client.none("error", 150);
  });

  test("a message flood is cut off with rate_limited and not relayed past the burst", async () => {
    t = start();
    const a = await Client.join(t.ws(), "alice");
    const b = await Client.join(t.ws(), "bob");
    clients.push(a.client, b.client);
    for (let i = 0; i < 100; i++) a.client.send({ type: "chat", text: `spam ${String(i)}` });
    expect((await a.client.next("error")).code).toBe("rate_limited");
    await Bun.sleep(100);
    let relayed = 0;
    for (;;) {
      try {
        await b.client.next("chat", 20);
        relayed++;
      } catch {
        break;
      }
    }
    expect(relayed).toBeGreaterThan(0);
    expect(relayed).toBeLessThan(40);
  });

  test("too many sockets from one address are refused with 429", async () => {
    t = start({ maxConnectionsPerIp: 3 });
    for (let i = 0; i < 3; i++) await open(t.ws());
    const res = await fetch(`${t.http}/rooms/lobby/ws`, { headers: { upgrade: "websocket" } });
    expect(res.status).toBe(429);
    clients.pop()?.close();
    await Bun.sleep(50);
    await open(t.ws());
  });

  test("share is rate limited per address with 429 rate_limited", async () => {
    t = start();
    const server = t;
    // Several members, so the per-member bucket isn't what trips.
    const tokens = await Promise.all(["a", "b", "c", "d"].map(async (n) => tokenOf((await join(server, n)).snapshot)));
    const statuses: number[] = [];
    for (let i = 0; i < 20; i++) {
      const res = await postShare(server, JSON.stringify({ url: "https://youtu.be/dQw4w9WgXcQ" }), {
        token: tokens[i % tokens.length] ?? "",
      });
      statuses.push(res.status);
      if (res.status === 429) {
        const body = v.parse(ShareResponseSchema, await res.json());
        expect(body.ok ? null : body.error.code).toBe("rate_limited");
      }
    }
    expect(statuses[0]).toBe(200);
    expect(statuses.at(-1)).toBe(429);
  });

  test("a chunked share body over 4 KB of UTF-8 is refused, even under 4096 characters", async () => {
    t = start();
    const token = tokenOf((await join(t, "sharer")).snapshot);
    const body = Buffer.from(JSON.stringify({ url: "https://youtu.be/" + "é".repeat(2100) }));
    expect(body.toString().length).toBeLessThan(4096);
    expect(body.length).toBeGreaterThan(4096);
    const port = t.server.port ?? 0;
    // Raw HTTP so there is no content-length: fetch() would add one.
    const head = `POST /rooms/lobby/share HTTP/1.1\r\nhost: 127.0.0.1:${String(port)}\r\nauthorization: Bearer ${token}\r\ncontent-type: application/json\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n`;
    const raw = Buffer.concat([Buffer.from(head + body.length.toString(16) + "\r\n"), body, Buffer.from("\r\n0\r\n\r\n")]);
    const response = await new Promise<string>((resolve) => {
      let got = "";
      void Bun.connect({
        hostname: "127.0.0.1",
        port,
        socket: {
          open(sock) {
            sock.write(raw);
          },
          data(_sock, chunk) {
            got += chunk.toString();
          },
          close() {
            resolve(got);
          },
        },
      });
    });
    expect(response.split("\r\n")[0]).toBe("HTTP/1.1 413 Payload Too Large");
    expect(response).toContain("payload_too_large");
  });

  test("the latency probe fails fast and cleans up when the server refuses its sockets", async () => {
    t = start({ maxConnectionsPerIp: 2 });
    const started = performance.now();
    let error: unknown = null;
    try {
      await measureRelayLatency({ url: t.ws(), clients: 4, samples: 1, timeoutMs: 1500 });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toMatch(/refused|closed/);
    expect(performance.now() - started).toBeLessThan(1000);
    await Bun.sleep(50);
    expect(t.server.pendingWebSockets).toBe(0);
  });

  test("the latency probe refuses a run with no samples", async () => {
    t = start();
    let error: unknown = null;
    try {
      await measureRelayLatency({ url: t.ws(), clients: 2, samples: 0 });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(Error);
  });
});

/** A clock the test moves by hand (ms), handed to the server's limiters so no test sleeps for a refill. */
function fakeClock() {
  const clock = { ms: 1_000_000, now: () => clock.ms };
  return clock;
}
/** Behind the local proxy, so each test address is its own client key (ADR 0015 §5). */
const as = (address: string): Record<string, string> => ({ "x-forwarded-for": address });
const chat = (text: string) => ({ type: "chat", text });
const YT = "https://youtu.be/dQw4w9WgXcQ";

async function pingPong(c: Client): Promise<void> {
  c.send({ type: "ping", id: 1 });
  await c.next("pong");
}
async function upgradeStatus(server: TestServer, headers: Record<string, string>): Promise<Response> {
  return fetch(`${server.http}/rooms/lobby/ws`, { headers: { upgrade: "websocket", ...headers } });
}

describe("M3 per-socket limiters (threat model §6)", () => {
  test("[Chat fan-out flood] chat: a burst of 5 relays, the 6th gets rate_limited with retryAfterMs, a refill restores it", async () => {
    const clock = fakeClock();
    t = start({ now: clock.now });
    const a = await join(t, "alice");
    const b = await join(t, "bob");
    for (let i = 0; i < 5; i++) a.client.send(chat(`hi ${String(i)}`));
    for (let i = 0; i < 5; i++) expect((await b.client.next("chat")).text).toBe(`hi ${String(i)}`);
    a.client.send(chat("one too many"));
    const refused = await a.client.next("error");
    expect(refused.code).toBe("rate_limited");
    expect(refused.retryAfterMs).toBe(1000);
    await b.client.none("chat", 50);
    clock.ms += 1000;
    a.client.send(chat("after refill"));
    expect((await b.client.next("chat")).text).toBe("after refill");
  });

  test("[Sit spam] sit: a burst of 4 relays, the 5th gets rate_limited with retryAfterMs, a refill restores it", async () => {
    const clock = fakeClock();
    t = start({ now: clock.now });
    const a = await join(t, "alice");
    const b = await join(t, "bob");
    for (let i = 0; i < 4; i++) a.client.send({ type: "sit", seat: i % 2 === 0 ? 0 : null });
    for (let i = 0; i < 4; i++) await b.client.next("seat-changed");
    a.client.send({ type: "sit", seat: 1 });
    const refused = await a.client.next("error");
    expect(refused.code).toBe("rate_limited");
    expect(refused.retryAfterMs).toBe(1000);
    await b.client.none("seat-changed", 50);
    clock.ms += 1000;
    a.client.send({ type: "sit", seat: 1 });
    expect((await b.client.next("seat-changed")).seat).toBe(1);
  });

  test("[Seek war] control per socket (L2): a burst of 4, the 5th gets rate_limited with retryAfterMs 250, a refill restores it", async () => {
    const clock = fakeClock();
    t = start({ now: clock.now });
    const a = await join(t, "alice");
    const b = await join(t, "bob");
    expect((await postShare(t, JSON.stringify({ url: YT }), { token: tokenOf(a.snapshot) })).status).toBe(200);
    const url = (await b.client.next("embed-changed")).embed?.url ?? "";
    for (let i = 0; i < 4; i++) a.client.send({ type: "control", url, playing: i % 2 === 0, position: 10 * i });
    for (let i = 0; i < 4; i++) await b.client.next("playback");
    a.client.send({ type: "control", url, playing: true, position: 99 });
    const refused = await a.client.next("error");
    expect(refused.code).toBe("rate_limited");
    expect(refused.retryAfterMs).toBe(250);
    clock.ms += 250;
    a.client.send({ type: "control", url, playing: true, position: 120 });
    expect((await b.client.next("playback")).playback.position).toBe(120);
  });

  test("[Chat fan-out flood] L1: 20 frames pass, the next gets rate_limited with retryAfterMs 100, a refill restores it", async () => {
    const clock = fakeClock();
    t = start({ now: clock.now });
    const c = await open(t.ws());
    for (let i = 0; i < 20; i++) c.send({ type: "ping", id: i });
    for (let i = 0; i < 20; i++) await c.next("pong");
    c.send({ type: "ping", id: 20 });
    const refused = await c.next("error");
    expect(refused.code).toBe("rate_limited");
    expect(refused.retryAfterMs).toBe(100);
    clock.ms += 100;
    await pingPong(c);
  });
});

describe("M3 room limiters (threat model §6)", () => {
  test("[Seek war] room control: 8 controls across members pass, the 9th gets rate_limited with retryAfterMs 250, a refill restores it", async () => {
    const clock = fakeClock();
    t = start({ now: clock.now });
    const members = [await join(t, "alice"), await join(t, "bob"), await join(t, "carol")];
    const [a, b, c] = members;
    if (a === undefined || b === undefined || c === undefined) throw new Error("unreachable");
    expect((await postShare(t, JSON.stringify({ url: YT }), { token: tokenOf(a.snapshot) })).status).toBe(200);
    const url = (await c.client.next("embed-changed")).embed?.url ?? "";
    // 4 + 4 stay inside each socket's own burst; the room aggregate is what trips.
    for (const m of [a, b]) for (let i = 0; i < 4; i++) m.client.send({ type: "control", url, playing: true, position: 10 * i });
    for (let i = 0; i < 8; i++) await c.client.next("playback");
    c.client.send({ type: "control", url, playing: false, position: 5 });
    const refused = await c.client.next("error");
    expect(refused.code).toBe("rate_limited");
    expect(refused.retryAfterMs).toBe(250);
    await a.client.none("playback", 50);
    clock.ms += 250;
    c.client.send({ type: "control", url, playing: false, position: 5 });
    expect((await c.client.next("playback")).playback.by).toBe(c.snapshot.self);
  });
});

describe("M3 room limiters are not the sender's flood", () => {
  test("[Seek war] a control refused by the room limiter gets its own notice and never counts toward the sender's 4029 streak", async () => {
    const clock = fakeClock();
    t = start({ now: clock.now });
    const a = await join(t, "alice");
    const b = await join(t, "bob");
    const c = await join(t, "carol");
    expect((await postShare(t, JSON.stringify({ url: YT }), { token: tokenOf(a.snapshot) })).status).toBe(200);
    const url = (await c.client.next("embed-changed")).embed?.url ?? "";
    for (const m of [a, b]) for (let i = 0; i < 4; i++) m.client.send({ type: "control", url, playing: true, position: 10 * i });
    for (let i = 0; i < 8; i++) await c.client.next("playback");
    // Carol stays inside her own burst of 4 each time, so every refusal is the room's.
    for (let round = 0; round < 15; round++) {
      for (let i = 0; i < 4; i++) {
        c.client.send({ type: "control", url, playing: false, position: 5 });
        const refused = await c.client.next("error");
        expect(refused.code).toBe("rate_limited");
      }
      // 1 s refills carol's 4 and the room's 4; alice takes the room's 4 again.
      clock.ms += 1000;
      for (let i = 0; i < 4; i++) a.client.send({ type: "control", url, playing: true, position: 10 * i });
      for (let i = 0; i < 4; i++) await c.client.next("playback");
    }
    expect(c.client.socket.readyState).toBe(WebSocket.OPEN);
  });
});

describe("M3 per-key limiters (threat model §6, ADR 0015 client key)", () => {
  test("[Reconnect churn] upgrade: 10 per key pass, the 11th gets HTTP 429 with Retry-After, other keys and a refill pass", async () => {
    const clock = fakeClock();
    t = start({ now: clock.now, trustProxy: true });
    for (let i = 0; i < 10; i++) {
      // Wait for each close, so the per-key connection cap (C1) never counts them.
      const c = await Client.open(t.ws(), undefined, as("198.51.100.1"));
      c.close();
      await c.closed;
    }
    const refused = await upgradeStatus(t, as("198.51.100.1"));
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("2");
    clients.push(await Client.open(t.ws(), undefined, as("198.51.100.2")));
    clock.ms += 2000;
    clients.push(await Client.open(t.ws(), undefined, as("198.51.100.1")));
  });

  test("[Join/leave churn] join: 6 joins per key pass, the 7th gets rate_limited with retryAfterMs 5000 and stays unjoined, a refill restores it", async () => {
    const clock = fakeClock();
    t = start({ now: clock.now, trustProxy: true });
    const c = await Client.open(t.ws(), undefined, as("198.51.100.1"));
    clients.push(c);
    for (let i = 0; i < 6; i++) {
      c.send({ type: "join", nickname: "alice", avatar: 0 });
      await c.next("snapshot");
      c.send({ type: "leave" });
    }
    c.send({ type: "join", nickname: "alice", avatar: 0 });
    const refused = await c.next("error");
    expect(refused.code).toBe("rate_limited");
    expect(refused.retryAfterMs).toBe(5000);
    c.send(chat("am I in?"));
    expect((await c.next("error")).code).toBe("not_joined");
    const other = await Client.join(t.ws(), "bob", 0, as("198.51.100.2"));
    clients.push(other.client);
    clock.ms += 5000;
    c.send({ type: "join", nickname: "alice", avatar: 0 });
    await c.next("snapshot");
  });

  test("[Room squatting] at most 5 members per key per room: the 6th gets too_many_members and stays open, unjoined", async () => {
    const clock = fakeClock();
    t = start({ now: clock.now, trustProxy: true, joinTimeoutMs: 200 });
    const five = [];
    for (let i = 0; i < 5; i++) five.push(await Client.join(t.ws(), `squat${String(i)}`, 0, as("198.51.100.1")));
    clients.push(...five.map((m) => m.client));
    const sixth = await Client.open(t.ws(), undefined, as("198.51.100.1"));
    clients.push(sixth);
    sixth.send({ type: "join", nickname: "squat5", avatar: 0 });
    expect((await sixth.next("error")).code).toBe("too_many_members");
    expect(sixth.socket.readyState).toBe(WebSocket.OPEN);
    clients.push((await Client.join(t.ws(), "neighbour", 0, as("198.51.100.2"))).client);
    five[0]?.client.send({ type: "leave" });
    await five[1]?.client.next("member-left");
    // The key has used its 6 joins; this one is past the join limiter's refill.
    clock.ms += 5000;
    sixth.send({ type: "join", nickname: "squat5", avatar: 0 });
    await sixth.next("snapshot");
  });

  test("[Room squatting] loopback peers are exempt from the per-key limits (local dev, the load probe)", async () => {
    t = start();
    for (let i = 0; i < 12; i++) clients.push((await Client.join(t.ws(), `local${String(i)}`)).client);
  });
});

describe("M3 nickname uniqueness (threat model §3, ADR 0016 §2)", () => {
  test("[Name impersonation] a join whose nicknameKey matches a member's gets nickname_taken and stays unjoined until the join timeout", async () => {
    t = start({ joinTimeoutMs: 300 });
    const alice = await join(t, "Alice");
    const copycat = await open(t.ws());
    for (const nickname of ["alice", "ALÍCE", "Ａｌｉｃｅ"]) {
      copycat.send({ type: "join", nickname, avatar: 1 });
      expect((await copycat.next("error")).code).toBe("nickname_taken");
    }
    await alice.client.none("member-joined", 50);
    expect((await copycat.closed).code).toBe(CLOSE_CODES.JOIN_TIMEOUT);
  });

  test("[Name impersonation] a UTS #39 confusable of a member's name gets nickname_taken, a different name joins (ADR 0023)", async () => {
    t = start();
    await join(t, "Alice");
    const copycat = await open(t.ws());
    // "Аӏісе": all Cyrillic, escaped so the test reads unambiguously.
    for (const nickname of ["\u0410\u04cf\u0456\u0441\u0435", "A1ice"]) {
      copycat.send({ type: "join", nickname, avatar: 1 });
      expect((await copycat.next("error")).code).toBe("nickname_taken");
    }
    copycat.send({ type: "join", nickname: "Alicia", avatar: 1 });
    await copycat.next("snapshot");
  });

  test("[Name impersonation] the name is free again once its member leaves", async () => {
    t = start();
    const alice = await join(t, "alice");
    const other = await open(t.ws());
    other.send({ type: "join", nickname: "alice", avatar: 0 });
    expect((await other.next("error")).code).toBe("nickname_taken");
    alice.client.send({ type: "leave" });
    await Bun.sleep(20);
    other.send({ type: "join", nickname: "alice", avatar: 0 });
    await other.next("snapshot");
  });
});

describe("M3 escalation closes (threat model §6)", () => {
  test("[Sustained flood never escalated] 49 dropped frames in a row keep the socket, the 50th closes it with 4029", async () => {
    const clock = fakeClock();
    t = start({ now: clock.now });
    const a = await join(t, "alice");
    // Chat 1–5 pass; 6–54 are 49 drops (chat bucket, then L1).
    for (let i = 0; i < 54; i++) a.client.send(chat(`spam ${String(i)}`));
    await a.client.next("error");
    // Let the server read the rest of the drops before the clock moves (they produce no reply to wait for).
    await Bun.sleep(50);
    clock.ms += 1000;
    await pingPong(a.client);
    // A frame that passes ends the streak; the chat bucket has refilled one token.
    a.client.send(chat("again"));
    for (let i = 0; i < 50; i++) a.client.send(chat(`spam ${String(i)}`));
    expect((await a.client.closed).code).toBe(CLOSE_CODES.RATE_LIMITED);
  });

  test("[Sustained flood never escalated] 19 bad_messages keep the socket, the 20th closes it with 4400", async () => {
    const clock = fakeClock();
    t = start({ now: clock.now });
    const c = await open(t.ws());
    for (let i = 0; i < 19; i++) c.send(i % 2 === 0 ? "{not json" : { type: "chat", text: 5 });
    for (let i = 0; i < 19; i++) expect((await c.next("error")).code).toBe("bad_message");
    clock.ms += 1000;
    await pingPong(c);
    c.send({ type: "nope" });
    expect((await c.closed).code).toBe(CLOSE_CODES.BAD_MESSAGES);
  });

  test("[Ad hoc close codes] the member past MAX_ROOM_MEMBERS gets room-full and close 4002", async () => {
    t = start();
    for (let i = 0; i < 25; i++) clients.push((await Client.join(t.ws(), `m${String(i)}`)).client);
    const late = await open(t.ws());
    late.send({ type: "join", nickname: "late", avatar: 0 });
    await late.next("room-full");
    expect((await late.closed).code).toBe(CLOSE_CODES.ROOM_FULL);
  });
});

/** A raw TCP WebSocket client that joins and then never reads again. */
async function slowReader(server: TestServer, nickname: string): Promise<Socket> {
  const port = server.server.port ?? 0;
  const sock = connect(port, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    sock.once("error", reject);
    sock.once("connect", () => {
      sock.write(
        `GET /rooms/lobby/ws HTTP/1.1\r\nhost: 127.0.0.1:${String(port)}\r\nupgrade: websocket\r\nconnection: Upgrade\r\n` +
          `sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\nsec-websocket-version: 13\r\n\r\n`,
      );
    });
    sock.once("data", (chunk: Buffer) => {
      if (!chunk.toString().startsWith("HTTP/1.1 101")) reject(new Error(`no upgrade: ${chunk.toString()}`));
      else resolve();
    });
  });
  // One masked text frame (RFC 6455 §5.2); the payload is short, so a 7-bit length.
  const payload = Buffer.from(JSON.stringify({ type: "join", nickname, avatar: 0 }));
  const mask = Buffer.from([1, 2, 3, 4]);
  const masked = payload.map((byte, i) => byte ^ (mask[i % 4] ?? 0));
  sock.write(Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]));
  await Bun.sleep(50);
  sock.pause();
  return sock;
}

describe("M3 transport limits (threat model §6)", () => {
  test("[Slow reader] a member that stops reading is closed at the backpressure limit, not Bun's 16 MB; the others keep relaying", async () => {
    t = start();
    const a = await join(t, "alice");
    const b = await join(t, "bob");
    const slow = await slowReader(t, "sloth");
    // Bob joined after alice, so the only join bob sees is the sloth's.
    const sloth = (await b.client.next("member-joined")).member.id;
    // Chat is capped per socket, so the server's own publish plays the room's broadcasts. Loopback kernel
    // buffers absorb a few MB before Bun buffers anything, so publish until the sloth is dropped.
    const frame = JSON.stringify({ type: "chat", memberId: sloth, text: "x".repeat(250), at: 0 });
    const seen = { left: false };
    a.client.socket.addEventListener("message", (e: MessageEvent) => {
      if (typeof e.data === "string" && e.data.includes('"member-left"')) seen.left = true;
    });
    let sent = 0;
    const [baseA, baseB] = [a.client.raw.length, b.client.raw.length];
    for (let published = 0; !seen.left && sent < 16 * 1024 * 1024; ) {
      for (let i = 0; i < 64; i++, published++) {
        t.server.publish("room:lobby", frame);
        sent += frame.length;
      }
      // The honest members read on this same event loop: let them catch up, so only the sloth backs up.
      while (a.client.raw.length - baseA < published || b.client.raw.length - baseB < published) await Bun.sleep(1);
    }
    expect((await a.client.next("member-left", 2000)).memberId).toBe(sloth);
    expect(sent).toBeLessThan(16 * 1024 * 1024);
    a.client.send(chat("still here"));
    // Bob's inbox still holds the published chats; skip to the fresh one.
    while ((await b.client.next("chat")).text !== "still here");
    slow.destroy();
  });

  test("[Slow reader] [Idle policy implicit] the WebSocket handler pins backpressure and idle settings", () => {
    const { websocket } = createWs({
      joinTimeoutMs: 1000,
      rooms: new RoomRegistry(),
      publish: () => undefined,
      release: () => undefined,
      headers: securityHeaders(true),
      persistLayout: () => undefined,
      persistTitle: () => undefined,
      titleBlocked: () => false,
    });
    expect(websocket.backpressureLimit).toBe(256 * 1024);
    expect(websocket.closeOnBackpressureLimit).toBe(true);
    expect(websocket.idleTimeout).toBe(60);
    expect(websocket.sendPings).toBe(true);
    expect(websocket.maxPayloadLength).toBe(MAX_CLIENT_MESSAGE_BYTES);
  });

  test("[Oversized frames] a frame over the limit closes with 1006 and the server stays up", async () => {
    t = start();
    const c = await open(t.ws());
    c.send("x".repeat(MAX_CLIENT_MESSAGE_BYTES + 1));
    expect((await c.closed).code).toBe(1006);
    const after = await join(t, "after");
    expect(after.snapshot.room.members).toHaveLength(1);
  });
});
