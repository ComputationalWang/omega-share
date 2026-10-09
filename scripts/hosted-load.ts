#!/usr/bin/env bun
/**
 * Hosted capacity test and restart drill (OME-511, M6 plan Q2; docs/perf-budgets.md "Server, hosted").
 *
 * Load comes from the operator's machine. One machine is one address to the server, and the server
 * allows 5 members per address per room and 6 joins per address before pacing at 0.2/s, so 25 people
 * in a room can't come from one address. The script therefore sends most clients through an ssh
 * tunnel as `deploy` to the app port on the box (127.0.0.1:8787, the same hop Caddy takes) with an
 * `X-Forwarded-For` address of their own from 198.18.0.0/15 (RFC 2544, benchmarking). With
 * `TRUST_PROXY=loopback` the server keys every limit by that address, so each simulated person has
 * their own buckets, as real people do. `--public N` clients (default 5, at most 6: the join burst of
 * this machine's real address) go the real way, `wss://` through Caddy and TLS.
 *
 * Traffic per member is the server's sustained chat rate (1/s, CHAT_PER_SECOND) and per room the
 * room's sustained control rate (4 seeks/s, ROOM_CONTROL_PER_SECOND), actors rotating. Seats 0–7 are
 * taken by clients 0–7. Client 0 of each room is the owner and fills the queue (3 adds: the first
 * starts, two wait).
 *
 * Measured on the box over the same ssh connection: `/metrics` (127.0.0.1:9464: relay latency
 * histogram, RSS) and `/proc/<pid>/stat` (CPU) every 10 s.
 *
 * Usage (env from the repo's `.env`: SERVER_IP, DEPLOY_KEY_PATH):
 *   bun scripts/hosted-load.ts setup    --state <file> [--rooms 20]       # private rooms, owner tokens in <file> (0600)
 *   bun scripts/hosted-load.ts run      --state <file> [--clients 25] [--minutes 10] [--public 5] [--drill] [--out perf/results/hosted-load]
 *   bun scripts/hosted-load.ts privacy  --state <file> [--journal <file>] [--out …]   # metrics/logs grep + outside reachability
 *   bun scripts/hosted-load.ts tti      [--runs 5] [--out …]                # hosted TTI, Chromium "Fast 4G"
 *   bun scripts/hosted-load.ts teardown --state <file>                     # deletes the rooms
 * Keep `--state` outside the repo: it holds owner tokens and invite keys.
 */
import { spawn, type Subprocess } from "bun";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { CHAT_PER_SECOND, ROOM_CONTROL_BURST, ROOM_CONTROL_PER_SECOND } from "../apps/server/src/ws";
import { TokenBucket } from "../apps/server/src/rate-limit";
import { parseServerMessage, SEAT_COUNT, type ClientMessage } from "@omega/shared";
import {
  cpuPercent,
  findPersonalData,
  histogramQuantile,
  parseProcStat,
  parsePrometheus,
  percentile,
  relayHistogram,
  simulatedAddress,
  type RelayHistogram,
} from "./hosted-load-lib";

const BUDGET = { relayP95Ms: 50, rssMB: 300, cpuPercent: 70, restartS: 5 } as const;
const QUEUE_URLS = [
  "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
  "https://www.youtube.com/watch?v=eRsGyueVLvQ",
  "https://www.youtube.com/watch?v=M7lc1UVf-VE",
] as const;
const SAMPLE_MS = 10_000;
const BACKOFF_BASE_MS = 500; // apps/web/src/connection.ts
const BACKOFF_MAX_MS = 5000;

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    state: { type: "string" },
    rooms: { type: "string", default: "20" },
    clients: { type: "string", default: "25" },
    minutes: { type: "string", default: "10" },
    public: { type: "string", default: "5" },
    drill: { type: "boolean", default: false },
    journal: { type: "string" },
    runs: { type: "string", default: "5" },
    out: { type: "string" },
    "tunnel-port": { type: "string", default: "18787" },
  },
});

const env = (key: string): string => {
  const v = process.env[key];
  if (v === undefined || v === "") throw new Error(`${key} is not set (source the repo's .env)`);
  return v;
};
const ORIGIN = process.env["PUBLIC_ORIGIN"] ?? "https://omega-share.duckdns.org";
const HOST = new URL(ORIGIN).host;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const now = () => performance.now();
const round = (x: number | null, d = 2): number | null => (x === null ? null : Number.isFinite(x) ? Number(x.toFixed(d)) : x);
const log = (msg: string) => {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
};

// ---------------------------------------------------------------- state

interface RoomState {
  id: string;
  title: string;
  ownerToken: string;
  inviteKey: string;
}
interface State {
  origin: string;
  rooms: RoomState[];
}
const statePath = (): string => {
  if (opt.state === undefined) throw new Error("--state <file> is required");
  return opt.state;
};
const readState = (): State => {
  const p = statePath();
  if (!existsSync(p)) return { origin: ORIGIN, rooms: [] };
  return JSON.parse(readFileSync(p, "utf8")) as State;
};
const writeState = (s: State): void => {
  const p = statePath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(s, null, 2));
  chmodSync(p, 0o600);
};

// ---------------------------------------------------------------- the box (ssh master + tunnel)

class Box {
  private master: Subprocess | null = null;
  private readonly sock = `${process.env["XDG_RUNTIME_DIR"] ?? "/tmp"}/omega-qa2-load-${String(process.pid)}.sock`;
  readonly port = Number(opt["tunnel-port"]);
  private readonly target = `deploy@${env("SERVER_IP")}`;
  private readonly key = env("DEPLOY_KEY_PATH");

  async start(): Promise<void> {
    this.master = spawn(
      ["ssh", "-M", "-S", this.sock, "-N", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=15",
        "-i", this.key, "-L", `127.0.0.1:${String(this.port)}:127.0.0.1:8787`, this.target],
      { stdout: "inherit", stderr: "inherit" },
    );
    for (let i = 0; i < 100 && !existsSync(this.sock); i++) await sleep(100);
    if (!existsSync(this.sock)) throw new Error("ssh master didn't come up");
  }

  async exec(cmd: string): Promise<string> {
    const p = spawn(["ssh", "-S", this.sock, "-o", "BatchMode=yes", "-i", this.key, this.target, cmd], { stdout: "pipe", stderr: "inherit" });
    const out = await new Response(p.stdout).text();
    await p.exited;
    return out;
  }

  stop(): void {
    this.master?.kill();
  }

  /** HTTP to the app through the tunnel, as `address`. */
  fetch(path: string, address: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("host", HOST);
    headers.set("origin", ORIGIN);
    headers.set("x-forwarded-for", address);
    return fetch(`http://127.0.0.1:${String(this.port)}${path}`, { ...init, headers });
  }
}

interface BoxSample {
  at: number; // performance.now() ms
  wall: number; // box clock, s
  series: Map<string, number>;
  ticks: number;
  rssPages: number;
  clkTck: number;
  pageSize: number;
}

async function sampleBox(box: Box): Promise<BoxSample> {
  const at = now();
  const out = await box.exec(
    "pid=$(systemctl show -p MainPID --value omega-share); echo \"STAT $(cat /proc/$pid/stat)\"; echo \"CLK $(getconf CLK_TCK) $(getconf PAGESIZE) $(date +%s.%N)\"; curl -s -m 5 127.0.0.1:9464/metrics",
  );
  const statLine = /^STAT (.*)$/m.exec(out)?.[1] ?? "";
  const clk = /^CLK (\d+) (\d+) ([\d.]+)$/m.exec(out);
  const stat = parseProcStat(statLine);
  if (stat === null || clk === null) throw new Error(`bad box sample: ${out.slice(0, 200)}`);
  return {
    at,
    wall: Number(clk[3]),
    series: parsePrometheus(out),
    ticks: stat.ticks,
    rssPages: stat.rssPages,
    clkTck: Number(clk[1]),
    pageSize: Number(clk[2]),
  };
}

const rssMB = (s: BoxSample): number => (s.series.get("process_resident_memory_bytes") ?? s.rssPages * s.pageSize) / 2 ** 20;

// ---------------------------------------------------------------- clients

interface Expected {
  seat: number | null;
  embedUrl: string | null;
  itemId: string | null;
  queue: string[];
}

class LoadClient {
  ws: WebSocket | null = null;
  self: string | null = null;
  joined = false;
  stopping = false;
  attempts = 0;
  closes: Record<string, number> = {};
  errors: Record<string, number> = {};
  rateLimited = 0;
  chatsSent = 0;
  controlsSent = 0;
  chatLatency: number[] = [];
  controlLatency: number[] = [];
  seats: (string | null)[] = [];
  embedUrl: string | null = null;
  itemId: string | null = null;
  queue: string[] = [];
  private readonly pendingChat = new Map<string, number>();
  private readonly pendingControl = new Map<number, number>();
  private chatTimer: ReturnType<typeof setTimeout> | null = null;
  private chatSeq = 0;
  /** Restart drill: what this client must see again, and when it lost the connection. */
  expect: Expected | null = null;
  droppedAt: number | null = null;
  recoveredMs: number | null = null;

  constructor(
    readonly room: RoomState,
    readonly roomIndex: number,
    readonly index: number,
    readonly via: "tunnel" | "public",
    private readonly box: Box,
  ) {}

  get nickname(): string {
    return `L${String(this.roomIndex + 1).padStart(2, "0")}m${String(this.index).padStart(2, "0")}`;
  }
  get targetSeat(): number | null {
    return this.index < SEAT_COUNT ? this.index : null;
  }
  get seated(): boolean {
    return this.self !== null && this.targetSeat !== null && this.seats[this.targetSeat] === this.self;
  }

  connect(): void {
    const path = `/rooms/${encodeURIComponent(this.room.id)}/ws`;
    const ws =
      this.via === "public"
        ? new WebSocket(`${ORIGIN.replace(/^http/, "ws")}${path}`, { headers: { origin: ORIGIN } } as unknown as string[])
        : new WebSocket(`ws://127.0.0.1:${String(this.box.port)}${path}`, {
            headers: { host: HOST, origin: ORIGIN, "x-forwarded-for": simulatedAddress(this.roomIndex, this.index) },
          } as unknown as string[]);
    this.ws = ws;
    ws.onopen = () => {
      const join: ClientMessage =
        this.index === 0
          ? { type: "join", nickname: this.nickname, avatar: this.index % 4, ownerToken: this.room.ownerToken }
          : { type: "join", nickname: this.nickname, avatar: this.index % 4, inviteKey: this.room.inviteKey };
      ws.send(JSON.stringify(join));
    };
    ws.onmessage = (e) => {
      this.onMessage(String(e.data));
    };
    ws.onclose = (e) => {
      this.joined = false;
      this.closes[String(e.code)] = (this.closes[String(e.code)] ?? 0) + 1;
      if (this.chatTimer !== null) clearTimeout(this.chatTimer);
      this.chatTimer = null;
      if (this.droppedAt === null && this.expect !== null) this.droppedAt = now();
      if (this.stopping) return;
      // The web client's backoff (apps/web/src/connection.ts): 500 ms × 2^n, capped at 5 s, jittered 50–100 %.
      const nominal = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** this.attempts);
      this.attempts++;
      setTimeout(() => {
        if (!this.stopping) this.connect();
      }, Math.round(nominal * (0.5 + Math.random() / 2)));
    };
  }

  private onMessage(raw: string): void {
    // Every frame goes through the contract (about 2 µs each, measured): no casts on wire data.
    const msg = parseServerMessage(raw);
    if (msg === null) {
      this.errors["unparsed"] = (this.errors["unparsed"] ?? 0) + 1;
      return;
    }
    switch (msg.type) {
      case "snapshot": {
        this.self = msg.self;
        this.seats = [...msg.room.seats];
        this.embedUrl = msg.room.embed?.url ?? null;
        this.itemId = msg.room.itemId ?? null;
        this.queue = (msg.room.queue ?? []).map((q) => q.id);
        this.joined = true;
        this.attempts = 0;
        const t = this.targetSeat;
        if (t !== null && this.seats[t] !== this.self && this.seats[t] === null) this.send({ type: "sit", seat: t });
        this.checkRecovered();
        this.startChat();
        return;
      }
      case "seat-changed":
        this.seats = this.seats.map((s) => (s === msg.memberId ? null : s));
        if (msg.seat !== null) this.seats[msg.seat] = msg.memberId;
        return;
      case "member-left":
        this.seats = this.seats.map((s) => (s === msg.memberId ? null : s));
        return;
      case "embed-changed":
        this.embedUrl = msg.embed?.url ?? null;
        this.itemId = msg.itemId ?? null;
        return;
      case "queue-changed":
        this.queue = msg.queue.map((q) => q.id);
        return;
      case "chat": {
        if (msg.memberId !== this.self) return;
        const sent = this.pendingChat.get(msg.text);
        if (sent !== undefined) {
          this.chatLatency.push(now() - sent);
          this.pendingChat.delete(msg.text);
        }
        return;
      }
      case "playback": {
        const sent = this.pendingControl.get(msg.playback.position);
        if (sent !== undefined) {
          this.controlLatency.push(now() - sent);
          this.pendingControl.delete(msg.playback.position);
        }
        return;
      }
      case "error":
        if (msg.code === "rate_limited") this.rateLimited++;
        else this.errors[msg.code] = (this.errors[msg.code] ?? 0) + 1;
        return;
      case "member-joined":
      case "member-status":
      case "member-muted":
      case "emoted":
      case "pong":
      case "layout-changed":
      case "title-changed":
      case "control-policy-changed":
      case "room-full":
        return;
    }
  }

  send(m: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  /** Chat at the sustained rate (1/s), jittered up to +10 % so bursts never pile up. */
  private startChat(): void {
    if (this.chatTimer !== null) return;
    const tick = () => {
      if (!this.joined || this.stopping) {
        this.chatTimer = null;
        return;
      }
      const text = `${this.nickname} ${String(++this.chatSeq)}`;
      this.pendingChat.set(text, now());
      this.send({ type: "chat", text });
      this.chatsSent++;
      this.chatTimer = setTimeout(tick, (1000 / CHAT_PER_SECOND) * (1 + Math.random() * 0.1));
    };
    this.chatTimer = setTimeout(tick, Math.random() * 1000);
  }

  control(position: number): void {
    if (!this.joined || this.embedUrl === null) return;
    this.pendingControl.set(position, now());
    this.send({ type: "control", url: this.embedUrl, playing: true, position });
    this.controlsSent++;
  }

  checkRecovered(): void {
    const e = this.expect;
    if (e === null || this.droppedAt === null || this.recoveredMs !== null || !this.joined) return;
    const seatOk = e.seat === null || this.seats[e.seat] === this.self;
    const same = this.embedUrl === e.embedUrl && this.itemId === e.itemId && this.queue.join() === e.queue.join();
    if (seatOk && same) this.recoveredMs = now() - this.droppedAt;
  }

  stop(): void {
    this.stopping = true;
    if (this.chatTimer !== null) clearTimeout(this.chatTimer);
    this.send({ type: "leave" });
    this.ws?.close(1000);
  }
}

// ---------------------------------------------------------------- setup / teardown

async function setup(): Promise<void> {
  const want = Number(opt.rooms);
  const state = readState();
  const box = new Box();
  await box.start();
  try {
    while (state.rooms.length < want) {
      const i = state.rooms.length;
      const title = `QA2 load ${String(i + 1).padStart(2, "0")}`;
      const res = await box.fetch("/rooms", simulatedAddress(i, 253), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, visibility: "private" }),
      });
      const body = (await res.json()) as { ok: boolean; room?: { id: string }; ownerToken?: string; inviteKey?: string; error?: { retryAfterMs?: number } };
      if (res.status === 429) {
        const wait = body.error?.retryAfterMs ?? 60_000;
        log(`room ${String(i + 1)}: rate limited, waiting ${String(Math.ceil(wait / 1000))} s`);
        await sleep(wait + 500);
        continue;
      }
      if (!body.ok || body.room === undefined || body.ownerToken === undefined || body.inviteKey === undefined) {
        throw new Error(`create failed: ${String(res.status)} ${JSON.stringify(body.error)}`);
      }
      state.rooms.push({ id: body.room.id, title, ownerToken: body.ownerToken, inviteKey: body.inviteKey });
      writeState(state);
      log(`room ${String(i + 1)}/${String(want)} created`);
    }
  } finally {
    box.stop();
  }
}

async function teardown(): Promise<void> {
  const state = readState();
  const box = new Box();
  await box.start();
  try {
    for (const [i, r] of state.rooms.entries()) {
      const res = await box.fetch(`/rooms/${r.id}`, simulatedAddress(i, 253), { method: "DELETE", headers: { authorization: `Bearer ${r.ownerToken}` } });
      log(`room ${String(i + 1)}: DELETE ${String(res.status)}`);
    }
  } finally {
    box.stop();
  }
}

// ---------------------------------------------------------------- run

interface IntervalRow {
  t: number;
  cpuPercent: number | null;
  rssMB: number;
  relayP95Ms: number | null;
  sockets: number;
  members: number;
}

function windowSummary(samples: BoxSample[]) {
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (first === undefined || last === undefined) throw new Error("no samples");
  const rows: IntervalRow[] = [];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    if (a === undefined || b === undefined) continue;
    const p95 = histogramQuantile(relayHistogram(a.series), relayHistogram(b.series), 0.95);
    rows.push({
      t: Math.round((b.at - first.at) / 1000),
      cpuPercent: round(cpuPercent({ ticks: a.ticks, at: a.wall }, { ticks: b.ticks, at: b.wall }, b.clkTck), 1),
      rssMB: Number(rssMB(b).toFixed(1)),
      relayP95Ms: round(p95 === null ? null : p95 * 1000, 3),
      sockets: b.series.get("omega_sockets") ?? 0,
      members: b.series.get("omega_members") ?? 0,
    });
  }
  const h0: RelayHistogram = relayHistogram(first.series);
  const h1: RelayHistogram = relayHistogram(last.series);
  const q = (x: number) => {
    const v = histogramQuantile(h0, h1, x);
    return round(v === null ? null : v * 1000, 3);
  };
  const cpus = rows.map((r) => r.cpuPercent).filter((c): c is number => c !== null);
  return {
    seconds: Math.round((last.at - first.at) / 1000),
    relayFrames: h1.count - h0.count,
    relayP50Ms: q(0.5),
    relayP95Ms: q(0.95),
    relayP99Ms: q(0.99),
    relayMeanMs: round(h1.count > h0.count ? ((h1.sum - h0.sum) / (h1.count - h0.count)) * 1000 : null, 4),
    cpuAvgPercent: round(cpuPercent({ ticks: first.ticks, at: first.wall }, { ticks: last.ticks, at: last.wall }, last.clkTck), 1),
    cpuMaxIntervalPercent: cpus.length > 0 ? Math.max(...cpus) : null,
    rssMaxMB: Math.max(...samples.map(rssMB)).toFixed(1),
    rows,
  };
}

function clientSummary(clients: LoadClient[]) {
  const chat = clients.flatMap((c) => c.chatLatency);
  const control = clients.flatMap((c) => c.controlLatency);
  const sumBy = (f: (c: LoadClient) => Record<string, number>) => {
    const out: Record<string, number> = {};
    for (const c of clients) for (const [k, v] of Object.entries(f(c))) out[k] = (out[k] ?? 0) + v;
    return out;
  };
  return {
    chatsSent: clients.reduce((n, c) => n + c.chatsSent, 0),
    controlsSent: clients.reduce((n, c) => n + c.controlsSent, 0),
    rateLimited: clients.reduce((n, c) => n + c.rateLimited, 0),
    errors: sumBy((c) => c.errors),
    closes: sumBy((c) => c.closes),
    /** Sender's own echo, measured here: includes the round trip to the box (and ssh for tunnel clients). */
    chatEchoP50Ms: round(percentile(chat, 0.5), 1),
    chatEchoP95Ms: round(percentile(chat, 0.95), 1),
    controlEchoP50Ms: round(percentile(control, 0.5), 1),
    controlEchoP95Ms: round(percentile(control, 0.95), 1),
  };
}

async function run(): Promise<void> {
  const state = readState();
  const perRoom = Number(opt.clients);
  const minutes = Number(opt.minutes);
  const publicCount = Number(opt.public);
  if (publicCount > 6) throw new Error("--public is at most 6: the join burst of one address");
  if (state.rooms.length === 0) throw new Error("no rooms: run setup first");
  const out = opt.out ?? "perf/results/hosted-load";
  const box = new Box();
  await box.start();
  const release = (await box.exec("readlink -f /opt/omega-share/current")).trim().split("/").pop() ?? "?";
  log(`box release ${release}, ${String(state.rooms.length)} rooms × ${String(perRoom)} clients, ${String(publicCount)} via wss`);

  const clients: LoadClient[] = [];
  for (const [r, room] of state.rooms.entries()) {
    for (let i = 0; i < perRoom; i++) {
      // Public clients: client 1 (seated) of the first rooms.
      const via = i === 1 && r < publicCount ? "public" : "tunnel";
      clients.push(new LoadClient(room, r, i, via, box));
    }
  }
  const owners = clients.filter((c) => c.index === 0);

  // Ramp: owners first (they fill the queue), then everyone at ~50 joins/s.
  const ramp0 = now();
  for (const c of owners) c.connect();
  await waitFor(() => owners.every((c) => c.joined), 30_000, "owners joined");
  for (const o of owners) {
    const missing = QUEUE_URLS.length - (o.embedUrl === null ? 0 : 1) - o.queue.length;
    for (const url of QUEUE_URLS.slice(QUEUE_URLS.length - Math.max(0, missing))) o.send({ type: "queue-add", url });
  }
  await waitFor(() => owners.every((o) => o.embedUrl !== null && o.queue.length >= QUEUE_URLS.length - 1), 30_000, "embed + queue in every room");
  for (const c of clients) {
    if (c.index === 0) continue;
    c.connect();
    await sleep(20);
  }
  await waitFor(() => clients.every((c) => c.joined && (c.targetSeat === null || c.seated)), 120_000, "all joined and seated");
  log(`ramp done in ${String(Math.round((now() - ramp0) / 1000))} s`);

  // Control: per room, 4 seeks/s through a bucket that mirrors the room's, actors rotating.
  let controlActor = 0;
  const roomBuckets = state.rooms.map(() => new TokenBucket(ROOM_CONTROL_BURST, ROOM_CONTROL_PER_SECOND));
  const controlTimer = setInterval(() => {
    for (const [r] of state.rooms.entries()) {
      if (roomBuckets[r]?.take() !== true) continue;
      const actor = clients[r * perRoom + (controlActor % perRoom)];
      actor?.control(Math.round(Math.random() * 600_000) / 1000);
    }
    controlActor++;
  }, 1000 / ROOM_CONTROL_PER_SECOND);

  // Steady window, sampled every 10 s.
  await sleep(5000);
  const samples: BoxSample[] = [await sampleBox(box)];
  for (const c of clients) {
    c.chatLatency = [];
    c.controlLatency = [];
  }
  const steadyEnd = now() + minutes * 60_000;
  while (now() < steadyEnd) {
    await sleep(Math.min(SAMPLE_MS, steadyEnd - now()));
    const s = await sampleBox(box);
    samples.push(s);
    const row = windowSummary(samples.slice(-2)).rows[0];
    log(`t+${String(Math.round((s.at - (samples[0]?.at ?? 0)) / 1000))}s cpu ${String(row?.cpuPercent)}% rss ${String(row?.rssMB)} MB relay p95 ${String(row?.relayP95Ms)} ms members ${String(row?.members)}`);
  }
  const steady = { box: windowSummary(samples), clients: clientSummary(clients) };

  const drill = opt.drill ? await restartDrill(box, clients) : null;

  clearInterval(controlTimer);
  for (const c of clients) c.stop();
  await sleep(1000);
  const finalMetrics = await box.exec("curl -s -m 5 127.0.0.1:9464/metrics");
  box.stop();

  const b = steady.box;
  const checks = {
    relayP95: b.relayP95Ms !== null && b.relayP95Ms <= BUDGET.relayP95Ms,
    rss: Number(b.rssMaxMB) <= BUDGET.rssMB,
    cpu: b.cpuAvgPercent !== null && b.cpuAvgPercent <= BUDGET.cpuPercent,
    rateLimited: steady.clients.rateLimited === 0,
    restart: drill === null ? null : drill.notRecovered.length === 0 && drill.dropToBackMaxS !== null && drill.dropToBackMaxS <= BUDGET.restartS,
  };
  const report = {
    issue: "OME-511",
    at: new Date().toISOString(),
    release,
    origin: ORIGIN,
    config: {
      rooms: state.rooms.length,
      clientsPerRoom: perRoom,
      clients: clients.length,
      viaWss: clients.filter((c) => c.via === "public").length,
      viaTunnel: clients.filter((c) => c.via === "tunnel").length,
      minutes,
      chatPerMemberPerS: CHAT_PER_SECOND,
      controlPerRoomPerS: ROOM_CONTROL_PER_SECOND,
      seatedPerRoom: Math.min(perRoom, SEAT_COUNT),
    },
    budget: BUDGET,
    checks,
    steady,
    drill,
    finalMetrics,
  };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(`${out}.json`, `${JSON.stringify(report, null, 2)}\n`);
  log(`wrote ${out}.json — checks ${JSON.stringify(checks)}`);
}

/**
 * Restart drill: `systemctl restart omega-share` (what deploy.sh does) under full load. A client is back
 * when it has rejoined and sees itself in its old seat with the same embed, current item and queue.
 */
async function restartDrill(box: Box, clients: LoadClient[]) {
  log("restart drill: systemctl restart omega-share");
  for (const c of clients) c.expect = { seat: c.targetSeat, embedUrl: c.embedUrl, itemId: c.itemId, queue: [...c.queue] };
  // A seat-changed after the snapshot can complete a recovery too.
  const poll = setInterval(() => {
    for (const c of clients) c.checkRecovered();
  }, 20);
  const t0 = now();
  const restartOut = await box.exec("systemctl restart omega-share; echo RESTART-EXIT=$?");
  const restartCmdMs = now() - t0;
  await waitFor(() => clients.every((c) => c.recoveredMs !== null), 60_000, "every client back", false);
  clearInterval(poll);
  const secs = (ms: number | null) => round(ms === null ? null : ms / 1000, 2);
  const rec = clients.map((c) => c.recoveredMs).filter((x): x is number => x !== null);
  const sinceRestart = clients.flatMap((c) => (c.recoveredMs !== null && c.droppedAt !== null ? [c.droppedAt + c.recoveredMs - t0] : []));
  const pub = clients.filter((c) => c.via === "public").map((c) => c.recoveredMs);
  const result = {
    restartCommand: restartOut.trim(),
    restartCommandS: secs(restartCmdMs),
    clients: clients.length,
    recovered: rec.length,
    notRecovered: clients.filter((c) => c.recoveredMs === null).map((c) => ({ room: c.roomIndex + 1, client: c.index, via: c.via })),
    closeCodes: clientSummary(clients).closes,
    dropToBackP50S: secs(percentile(rec, 0.5)),
    dropToBackP95S: secs(percentile(rec, 0.95)),
    dropToBackMaxS: secs(rec.length > 0 ? Math.max(...rec) : null),
    restartToAllBackS: secs(sinceRestart.length > 0 ? Math.max(...sinceRestart) : null),
    viaWssMaxS: secs(pub.includes(null) || pub.length === 0 ? null : Math.max(...pub.filter((x): x is number => x !== null))),
    seatedBack: clients.filter((c) => c.targetSeat !== null && c.seated).length,
    seatedExpected: clients.filter((c) => c.targetSeat !== null).length,
    afterRestart: null as ReturnType<typeof windowSummary> | null,
  };
  log(`drill: ${JSON.stringify({ ...result, afterRestart: undefined })}`);
  // A minute of the same load on the new process.
  const after: BoxSample[] = [await sampleBox(box)];
  for (let i = 0; i < 6; i++) {
    await sleep(SAMPLE_MS);
    after.push(await sampleBox(box));
  }
  result.afterRestart = windowSummary(after);
  return result;
}

async function waitFor(cond: () => boolean, ms: number, what: string, fail = true): Promise<void> {
  const end = now() + ms;
  while (!cond()) {
    if (now() > end) {
      if (fail) throw new Error(`timed out: ${what}`);
      log(`timed out: ${what}`);
      return;
    }
    await sleep(50);
  }
}

// ---------------------------------------------------------------- privacy

const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const IPV6 = /\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{0,4}\b/gi;

async function privacy(): Promise<void> {
  const state = readState();
  const box = new Box();
  await box.start();
  const metrics = await box.exec("curl -s -m 5 127.0.0.1:9464/metrics");
  const myAddress = (await box.exec("echo ${SSH_CLIENT%% *}")).trim();
  const perRoom = Number(opt.clients);
  const nicknames = state.rooms.flatMap((_, r) => Array.from({ length: perRoom }, (_, i) => `L${String(r + 1).padStart(2, "0")}m${String(i).padStart(2, "0")}`));
  const needles = [...state.rooms.flatMap((r) => [r.id, r.title, r.ownerToken, r.inviteKey]), ...nicknames, "198.18.", "198.19.", myAddress, "lobby"];
  const scan = (text: string) => ({
    bytes: text.length,
    lines: text.split("\n").length,
    hits: findPersonalData(text, needles),
    ipv4: [...new Set(text.match(IPV4) ?? [])],
    ipv6: [...new Set(text.match(IPV6) ?? [])],
  });
  const journal = opt.journal === undefined ? null : scan(readFileSync(opt.journal, "utf8"));

  // From outside: the public origin (and Host tricks) must never serve metrics; the port must be closed.
  const outside: Record<string, string> = {};
  const probe = async (label: string, url: string, headers: Record<string, string> = {}) => {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000), redirect: "manual" });
      const text = await res.text();
      outside[label] = `${String(res.status)} ${text.includes("omega_relay_latency") ? "METRICS EXPOSED" : "no metrics"}`;
    } catch (err) {
      outside[label] = `no answer (${err instanceof Error ? err.name : "error"})`;
    }
  };
  await probe("https://origin/metrics", `${ORIGIN}/metrics`);
  await probe("https://origin/metrics Host:127.0.0.1:9464", `${ORIGIN}/metrics`, { host: "127.0.0.1:9464" });
  await probe(`http://${env("SERVER_IP")}:9464/metrics`, `http://${env("SERVER_IP")}:9464/metrics`);
  await probe("app port via tunnel /metrics", `http://127.0.0.1:${String(box.port)}/metrics`, { host: HOST });
  await probe("metrics port via tunnel-side Host check", `http://127.0.0.1:${String(box.port)}/metrics`, { host: "localhost:9464" });
  box.stop();
  const text = JSON.stringify({ at: new Date().toISOString(), needles: needles.length, metrics: scan(metrics), journal, outside }, null, 2);
  console.log(text);
  if (opt.out !== undefined) writeFileSync(opt.out, `${text}\n`);
}

// ---------------------------------------------------------------- TTI

/** Chrome DevTools' "Fast 4G" preset (front_end/core/sdk/NetworkManager.ts). */
const FAST_4G = { offline: false, latency: 60 * 2.75, downloadThroughput: ((9 * 1000 * 1000) / 8) * 0.9, uploadThroughput: ((1.5 * 1000 * 1000) / 8) * 0.9 };

async function tti(): Promise<void> {
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch({ headless: true });
  const runs = Number(opt.runs);
  const results: { url: string; tti: number[]; load: number[] }[] = [];
  for (const url of [`${ORIGIN}/`, `${ORIGIN}/rooms/lobby`]) {
    const tti: number[] = [];
    const load: number[] = [];
    for (let i = 0; i < runs; i++) {
      const ctx = await browser.newContext(); // cold cache every run
      const page = await ctx.newPage();
      const cdp = await ctx.newCDPSession(page);
      await cdp.send("Network.enable");
      await cdp.send("Network.emulateNetworkConditions", FAST_4G);
      // Same lab TTI as perf/site.perf.ts: max(DCL end, last long task end, omega:interactive mark).
      await page.addInitScript(() => {
        const store = globalThis as unknown as { __ends: number[] };
        store.__ends = [];
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) store.__ends.push(e.startTime + e.duration);
        }).observe({ type: "longtask", buffered: true });
      });
      await page.goto(url, { waitUntil: "load", timeout: 60_000 });
      await page.waitForTimeout(1000);
      const m = await page.evaluate(() => {
        const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
        const mark = performance.getEntriesByName("omega:interactive")[0]?.startTime ?? 0;
        const ends = (globalThis as unknown as { __ends: number[] }).__ends;
        return { tti: Math.max(nav?.domContentLoadedEventEnd ?? 0, mark, ...ends), load: nav?.loadEventEnd ?? 0 };
      });
      tti.push(Math.round(m.tti));
      load.push(Math.round(m.load));
      await ctx.close();
    }
    results.push({ url, tti, load });
    log(`${url}: TTI ${tti.join(", ")} ms`);
  }
  await browser.close();
  const report = {
    at: new Date().toISOString(),
    throttling: { preset: "Fast 4G (Chrome DevTools)", ...FAST_4G },
    target: "< 2500 ms (measured, not blocking in M6)",
    results: results.map((r) => ({ ...r, medianMs: percentile(r.tti, 0.5), maxMs: Math.max(...r.tti) })),
  };
  const text = JSON.stringify(report, null, 2);
  console.log(text);
  if (opt.out !== undefined) writeFileSync(opt.out, `${text}\n`);
}

const commands: Record<string, () => Promise<void>> = { setup, run, teardown, privacy, tti };
const command = commands[positionals[0] ?? ""];
if (command === undefined) {
  console.error("usage: bun scripts/hosted-load.ts setup|run|privacy|tti|teardown --state <file> …");
  process.exit(2);
}
await command();
process.exit(0);
