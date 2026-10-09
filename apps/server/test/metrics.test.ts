import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { CLOSE_CODES } from "@omega/shared";
import { startMetrics } from "../src/metrics";
import { Room } from "../src/room";
import { RoomRegistry } from "../src/rooms";
import { Client, start, type TestServer } from "./helpers";

// OME-504: GET /metrics on its own loopback port, Prometheus text, nothing that names a person or a room.
const NICK = "zelda-metrics-nick";
const ROOM = "metrics-secret-room";
const TITLE = "Very Private Title";

let t: TestServer;
let m: Server<unknown> | null = null;
let clients: Client[] = [];
afterEach(() => {
  for (const c of clients) c.close();
  clients = [];
  void m?.stop(true);
  m = null;
  void t.server.stop(true);
});

function boot(): { registry: RoomRegistry; metricsUrl: string } {
  const registry = new RoomRegistry();
  registry.addRoom(new Room(ROOM, { title: TITLE, pinned: false }));
  // A frozen limiter clock: no refill, so a flood reaches the 4029 close without sleeping.
  t = start({ registry, rooms: ["lobby"], now: () => 0 });
  const metrics = startMetrics({ port: 0, render: () => t.server.metricsText() });
  m = metrics;
  return { registry, metricsUrl: `http://127.0.0.1:${String(metrics.port)}/metrics` };
}

const wsUrl = (room: string) => t.ws(room);

/** Every line is a comment or `name{label="value"} number` with label values that are numbers or codes. */
const SAMPLE = /^[a-z_]+(\{(le|code)="(\d+(\.\d+)?(e[+-]?\d+)?|\+Inf)"\})? -?\d+(\.\d+)?(e[+-]?\d+)?$/;
const COMMENT = /^# (HELP|TYPE) [a-z_]+ .+$/;

function sample(text: string, name: string): number {
  const line = text.split("\n").find((l) => l.startsWith(`${name} `));
  if (line === undefined) throw new Error(`no sample ${name}`);
  return Number(line.slice(name.length + 1));
}

describe("metrics endpoint", () => {
  test("binds 127.0.0.1 only, serves Prometheus text, refuses other hosts, paths and methods", async () => {
    const { metricsUrl } = boot();
    expect(m?.hostname).toBe("127.0.0.1");
    const res = await fetch(metricsUrl);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; version=0.0.4; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await fetch(metricsUrl, { headers: { host: "omega-share.duckdns.org" } })).status).toBe(421);
    expect((await fetch(metricsUrl.replace("/metrics", "/"))).status).toBe(404);
    expect((await fetch(metricsUrl, { method: "POST" })).status).toBe(405);
  });

  test("counts rooms, sockets, members, relay latency, uptime and RSS", async () => {
    const { metricsUrl } = boot();
    const a = await Client.join(wsUrl(ROOM), NICK);
    const b = await Client.join(wsUrl("lobby"), "other-nick");
    clients.push(a.client, b.client);
    for (let i = 0; i < 3; i++) a.client.send({ type: "chat", text: `hello ${String(i)}` });
    await a.client.next("chat");
    const text = await (await fetch(metricsUrl)).text();
    expect(sample(text, "omega_rooms")).toBe(2);
    expect(sample(text, "omega_sockets")).toBe(2);
    expect(sample(text, "omega_members")).toBe(2);
    // Two joins and three chats were relayed.
    expect(sample(text, "omega_relay_latency_seconds_count")).toBeGreaterThanOrEqual(5);
    expect(sample(text, 'omega_relay_latency_seconds_bucket{le="+Inf"}')).toBe(sample(text, "omega_relay_latency_seconds_count"));
    expect(sample(text, "omega_relay_latency_seconds_sum")).toBeGreaterThan(0);
    expect(sample(text, "process_resident_memory_bytes")).toBeGreaterThan(1_000_000);
    expect(sample(text, "process_uptime_seconds")).toBeGreaterThan(0);
  });

  test("counts 4029 and 4004 closes", async () => {
    const { registry, metricsUrl } = boot();
    const before = await (await fetch(metricsUrl)).text();
    expect(sample(before, 'omega_ws_closes_total{code="4029"}')).toBe(0);
    expect(sample(before, 'omega_ws_closes_total{code="4004"}')).toBe(0);

    const flooder = await Client.join(wsUrl("lobby"), "flooder");
    for (let i = 0; i < 80; i++) flooder.client.send({ type: "chat", text: "x" });
    expect((await flooder.client.closed).code).toBe(CLOSE_CODES.RATE_LIMITED);

    const gone = await Client.join(wsUrl(ROOM), NICK);
    const room = registry.get(ROOM);
    if (room === undefined) throw new Error("room missing");
    registry.removeRoom(room);
    expect((await gone.client.closed).code).toBe(CLOSE_CODES.ROOM_CLOSED);

    const after = await (await fetch(metricsUrl)).text();
    expect(sample(after, 'omega_ws_closes_total{code="4029"}')).toBe(1);
    expect(sample(after, 'omega_ws_closes_total{code="4004"}')).toBe(1);
  });

  test("names no address, nickname, room id or title: every line is a known metric shape", async () => {
    const { metricsUrl } = boot();
    const a = await Client.join(wsUrl(ROOM), NICK);
    clients.push(a.client);
    a.client.send({ type: "chat", text: "hi from 203.0.113.9" });
    await a.client.next("chat");
    const text = await (await fetch(metricsUrl)).text();
    for (const secret of [NICK, ROOM, TITLE, "lobby", "127.0.0.1", "203.0.113.9", "::1"]) expect(text).not.toContain(secret);
    const lines = text.trimEnd().split("\n");
    expect(lines.length).toBeGreaterThan(10);
    for (const line of lines) expect(line).toMatch(line.startsWith("#") ? COMMENT : SAMPLE);
  });
});
