import { afterEach, describe, expect, test } from "bun:test";
import { TestClock } from "./clock";
import { envFor, NotBlackBox } from "./env";

describe("envFor: start() options become environment variables", () => {
  test("the defaults: ephemeral port, loopback, nothing on disk", () => {
    expect(envFor({}).env).toEqual({
      PORT: "0",
      HOST: "127.0.0.1",
      SITE_ORIGIN: "http://localhost:5173",
      DB_PATH: ":memory:",
    });
  });

  test("each mappable option has its variable", () => {
    const { env } = envFor({
      port: 0,
      hostname: "127.0.0.1",
      siteOrigin: "http://localhost:5173",
      publicOrigin: "https://x.example",
      staticDir: "/srv/site",
      extensionIds: ["a".repeat(32), "b".repeat(32)],
      trustProxy: true,
      maxConnections: 7,
      resumeGraceMs: 6000,
      maxHttpInFlight: 0,
      genericEmbeds: false,
      genericEmbedDenylist: ["bad.example", "worse.example"],
      roomTitleBlocklist: ["x", "y"],
      dbPath: "/tmp/omega.db",
    });
    expect(env).toEqual({
      PORT: "0",
      HOST: "127.0.0.1",
      SITE_ORIGIN: "http://localhost:5173",
      PUBLIC_ORIGIN: "https://x.example",
      STATIC_DIR: "/srv/site",
      EXTENSION_IDS: `${"a".repeat(32)},${"b".repeat(32)}`,
      TRUST_PROXY: "loopback",
      MAX_CONNECTIONS: "7",
      RESUME_GRACE_MS: "6000",
      MAX_HTTP_IN_FLIGHT: "0",
      GENERIC_EMBEDS: "off",
      GENERIC_EMBED_DENYLIST: "bad.example,worse.example",
      ROOM_TITLE_BLOCKLIST: "x,y",
      DB_PATH: "/tmp/omega.db",
    });
  });

  test("null and undefined options set nothing", () => {
    const { env } = envFor({
      publicOrigin: null,
      staticDir: null,
      extensionIds: null,
      registry: undefined,
      trustProxy: false,
    });
    expect(Object.keys(env).sort()).toEqual(["DB_PATH", "HOST", "PORT", "SITE_ORIGIN"]);
  });

  test("the WebSocket knobs map onto their variables", () => {
    const { env } = envFor({ joinTimeoutMs: 50, statusIntervalMs: 20, maxConnectionsPerIp: 2 });
    expect(env["JOIN_TIMEOUT_MS"]).toBe("50");
    expect(env["STATUS_INTERVAL_MS"]).toBe("20");
    expect(env["MAX_CONNECTIONS_PER_IP"]).toBe("2");
  });

  test("genericEmbeds true is on", () => {
    expect(envFor({ genericEmbeds: true }).env["GENERIC_EMBEDS"]).toBe("on");
  });

  test.each([
    ["registry", {}],
    ["store", {}],
    ["reportStore", {}],
    ["rooms", ["lobby"]],
    ["seatHolds", []],
    ["roomGcIntervalMs", 50],
    ["maxHttpInFlight", 2],
    ["maxConnectionsPerIp", 2],
    ["ownHosts", ["x"]],
    ["now", () => 1],
    ["wallNow", () => 1],
    ["schedule", () => () => undefined],
  ])("%s can't cross a process boundary", (key, value) => {
    expect(() => envFor({ [key]: value })).toThrow(NotBlackBox);
    expect(() => envFor({ [key]: value })).toThrow(key);
  });

  test("a TestClock's functions are allowed and fix the starting time", () => {
    const clock = new TestClock(42, 1_700_000_000_000);
    const mapped = envFor({
      now: clock.now,
      wallNow: clock.wallNow,
      schedule: clock.schedule,
    });
    expect(mapped.clock).toBe(clock);
    expect(mapped.env["OMEGA_TEST_MONO"]).toBe("42");
    expect(mapped.env["OMEGA_TEST_WALL"]).toBe("1700000000000");
  });

  test("the error names itself, so the runner can tell it from a failure in junit output", () => {
    expect(() => envFor({ registry: {} })).toThrow(expect.objectContaining({ name: "NotBlackBox" }));
  });

  test("two different clocks can't both drive one server", () => {
    const a = new TestClock();
    const b = new TestClock();
    expect(() => envFor({ now: a.now, wallNow: b.wallNow })).toThrow(NotBlackBox);
  });
});

describe("TestClock", () => {
  const servers: { stop(close?: boolean): void }[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.stop(true);
  });

  test("in process, set moves now() and wallNow()", async () => {
    const clock = new TestClock(10, 20);
    await clock.set({ mono: 15 });
    expect([clock.now(), clock.wallNow()]).toEqual([15, 20]);
    await clock.set({ wall: 99 });
    expect([clock.now(), clock.wallNow()]).toEqual([15, 99]);
  });

  test("in process, schedule runs a task once its deadline passes, in order, and cancel stops it", async () => {
    const clock = new TestClock(0, 0);
    const ran: string[] = [];
    clock.schedule(() => ran.push("b"), 20);
    clock.schedule(() => ran.push("a"), 10);
    const cancel = clock.schedule(() => ran.push("never"), 15);
    cancel();
    expect(await clock.pending()).toBe(2);
    await clock.set({ mono: 19 });
    expect(ran).toEqual(["a"]);
    await clock.set({ mono: 20 });
    expect(ran).toEqual(["a", "b"]);
    expect(await clock.pending()).toBe(0);
  });

  test("attached, set posts both clocks to /__test/time and pending asks the server", async () => {
    const seen: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        seen.push(`${req.method} ${new URL(req.url).pathname} ${await req.text()}`);
        return new Response(req.method === "GET" ? '{"pending":3}' : '{"fired":1}');
      },
    });
    servers.push(server);
    const clock = new TestClock(5, 6);
    clock.attach(`http://127.0.0.1:${String(server.port)}`);
    await clock.set({ mono: 50 });
    expect(seen).toEqual(['POST /__test/time {"mono":50,"wall":6}']);
    expect(await clock.pending()).toBe(3);
    expect(clock.now()).toBe(50);
  });

  test("attached, a refused set is an error", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("no", { status: 400 }),
    });
    servers.push(server);
    const clock = new TestClock();
    clock.attach(`http://127.0.0.1:${String(server.port)}`);
    const failure = await clock.set({ mono: 1 }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(String(failure)).toContain("400");
  });
});
