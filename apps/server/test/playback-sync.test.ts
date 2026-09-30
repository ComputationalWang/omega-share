import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client, start, type TestServer } from "./helpers";

const VIDEO = "dQw4w9WgXcQ";
const OTHER = "aaaaaaaaaaa";

let t: TestServer;
const clients: Client[] = [];
async function join(nickname: string) {
  const r = await Client.join(t.ws(), nickname);
  clients.push(r.client);
  return r;
}
async function open() {
  const c = await Client.open(t.ws());
  clients.push(c);
  return c;
}
async function share(videoId = VIDEO) {
  const res = await fetch(`${t.http}/rooms/lobby/share`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: `https://www.youtube.com/watch?v=${videoId}` }),
  });
  expect(res.status).toBe(200);
}

beforeEach(() => {
  t = start();
});
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await t.server.stop(true);
});

describe("ping", () => {
  test("is answered with pong before join, to the sender only", async () => {
    const watcher = await join("watcher");
    const c = await open();
    const before = Date.now();
    c.send({ type: "ping", id: 7 });
    const pong = await c.next("pong");
    expect(pong.id).toBe(7);
    expect(pong.at).toBeGreaterThanOrEqual(before);
    expect(pong.at).toBeLessThanOrEqual(Date.now());
    await watcher.client.none("pong");
  });

  test("is answered after join too, and never published", async () => {
    const a = await join("alice");
    const b = await join("bob");
    a.client.send({ type: "ping", id: 2 ** 31 - 1 });
    expect((await a.client.next("pong")).id).toBe(2 ** 31 - 1);
    await b.client.none("pong");
  });

  test("shares the socket's token bucket", async () => {
    const c = await open();
    for (let i = 0; i < 25; i++) c.send({ type: "ping", id: i });
    expect((await c.next("error")).code).toBe("rate_limited");
  });
});

describe("playback", () => {
  test("is null with no embed, and a share starts it at 0 with action load", async () => {
    const a = await join("alice");
    expect(a.snapshot.room.playback).toBeNull();
    await share();
    const changed = await a.client.next("embed-changed");
    expect(changed.playback).toMatchObject({ playing: true, position: 0, rate: 1, action: "load", by: null });
  });

  test("control fans out as playback to every member, the sender included", async () => {
    await share();
    const a = await join("alice");
    const b = await join("bob");
    const c = await join("carol");
    const rev = a.snapshot.room.playback?.rev ?? -1;
    b.client.send({ type: "control", url: `https://www.youtube.com/embed/${VIDEO}`, playing: false, position: 95 });
    for (const m of [a, b, c]) {
      const { playback } = await m.client.next("playback");
      expect(playback).toMatchObject({ playing: false, position: 95, action: "seek", by: b.snapshot.self, rev: rev + 1 });
    }
  });

  test("a late joiner's snapshot carries the current playback", async () => {
    await share();
    const a = await join("alice");
    a.client.send({ type: "control", url: `https://www.youtube.com/embed/${VIDEO}`, playing: false, position: 12.5 });
    const { playback } = await a.client.next("playback");
    const late = await join("late");
    expect(late.snapshot.room.playback).toEqual(playback);
  });

  test("a new share resets playback to load with a higher rev", async () => {
    await share();
    const a = await join("alice");
    a.client.send({ type: "control", url: `https://www.youtube.com/embed/${VIDEO}`, playing: false, position: 40 });
    const { playback: paused } = await a.client.next("playback");
    await share(OTHER);
    const changed = await a.client.next("embed-changed");
    expect(changed.playback).toMatchObject({ playing: true, position: 0, action: "load", by: null });
    expect(changed.playback?.rev ?? -1).toBeGreaterThan(paused.rev);
  });

  test("control needs join", async () => {
    await share();
    const c = await open();
    c.send({ type: "control", url: `https://www.youtube.com/embed/${VIDEO}`, playing: false, position: 0 });
    expect((await c.next("error")).code).toBe("not_joined");
  });

  test("control for a stale video or with no embed is refused with no_embed and not published", async () => {
    const a = await join("alice");
    const b = await join("bob");
    a.client.send({ type: "control", url: `https://www.youtube.com/embed/${VIDEO}`, playing: false, position: 0 });
    expect((await a.client.next("error")).code).toBe("no_embed");
    await share();
    a.client.send({ type: "control", url: `https://www.youtube.com/embed/${OTHER}`, playing: false, position: 0 });
    expect((await a.client.next("error")).code).toBe("no_embed");
    await b.client.none("playback");
  });

  test("more than 4 controls a second from one socket trips its control limiter", async () => {
    await share();
    const a = await join("alice");
    const b = await join("bob");
    for (let i = 0; i < 6; i++) a.client.send({ type: "control", url: `https://www.youtube.com/embed/${VIDEO}`, playing: i % 2 === 0, position: i * 10 });
    expect((await a.client.next("error")).code).toBe("rate_limited");
    let seen = 0;
    for (;;) {
      try {
        await b.client.next("playback", 150);
        seen++;
      } catch {
        break;
      }
    }
    expect(seen).toBe(4);
    // Other members are not affected.
    b.client.send({ type: "control", url: `https://www.youtube.com/embed/${VIDEO}`, playing: true, position: 0 });
    expect((await a.client.next("playback")).playback.by).toBe(b.snapshot.self);
  });
});
