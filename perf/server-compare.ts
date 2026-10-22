/**
 * External load generator and TS-vs-Rust server benchmark (ADR 0050 "better" gate, slice S9).
 *
 *   bun perf/server-compare.ts --server "bun apps/server/src/index.ts" --label ts > ts-1.json
 *   bun perf/server-compare.ts --server "apps-server-rs/target/release/omega-server serve" --label rs > rs-1.json
 *   bun perf/server-compare.ts --compare ts-1.json rs-1.json [--noise 5]
 *
 * The server is any command that honours the env contract (PORT, HOST, DB_PATH, ...) and prints
 * `omega-share server on http://host:port/`. Rooms are seeded into a fresh DB before it starts. Each room
 * gets `members` WebSocket clients, background chat/emote/presence/status at the server's sustained limits,
 * and `control` seek probes timed until every member of the room has the matching `playback`
 * (the `action: "control"` method of apps/server/src/relay-latency.ts). The server's /proc is sampled
 * every 250 ms. A run needs only localhost; stdout is one JSON report. The tool's own CPU is in the report
 * (`client.cpuPct`): near 100 means the load generator, not the server, is the limit.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalizeEmbed, DEFAULT_LAYOUT, EMOTE_KINDS, EMOTE_REFILL_MS, MAX_ROOM_MEMBERS } from "@omega/shared";
import { openDatabase } from "../apps/server/src/store/db";
import { RoomStore } from "../apps/server/src/store/rooms";
import { CHAT_PER_SECOND, ROOM_CONTROL_PER_SECOND } from "../apps/server/src/ws-limits";

import { cpuPercent, loopbackAddrs, percentile, readProc, SITE_ORIGIN, startServer as startServerCommand, WsConn } from "./server-load";

// The helpers moved to ./server-load (shared with server-soak); the tests and other tools still import them from here.
export { cpuPercent, loopbackAddrs, parseProcStat, parseProcStatus, percentile } from "./server-load";

const SAMPLE_MS = 250;
const PROBE_TIMEOUT_MS = 5000;

export type Args =
  | { mode: "run"; server: string; label: string; rooms: number; members: number; duration: number; probes: number; noise: number; batch: boolean }
  | { mode: "compare"; a: string; b: string; noise: number };

function intIn(name: string, raw: string | undefined, def: number, min: number, max: number): number {
  const n = raw === undefined ? def : Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer from ${String(min)} to ${String(max)}`);
  return n;
}

export function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string>();
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (!a.startsWith("--")) pos.push(a);
    else if (a === "--compare") pos.push("--compare");
    else flags.set(a.slice(2), argv[++i] ?? "");
  }
  const noise = Number(flags.get("noise") ?? 5);
  if (!(noise >= 0)) throw new Error("--noise must be a percentage ≥ 0");
  if (pos.includes("--compare")) {
    const files = pos.filter((p) => p !== "--compare");
    const [a, b] = files;
    if (files.length !== 2 || a === undefined || b === undefined) throw new Error("--compare needs two report files");
    return { mode: "compare", a, b, noise };
  }
  const server = flags.get("server");
  if (server === undefined || server === "") throw new Error('--server "<command>" is required');
  return {
    mode: "run",
    server,
    label: flags.get("label") ?? server,
    rooms: intIn("--rooms", flags.get("rooms"), 20, 1, 100),
    members: intIn("--members", flags.get("members"), MAX_ROOM_MEMBERS, 2, MAX_ROOM_MEMBERS),
    duration: intIn("--duration", flags.get("duration"), 60, 1, 3600),
    probes: intIn("--probes", flags.get("probes"), 60, 1, 100_000),
    noise,
    batch: false,
  };
}

export type Verdict = "better" | "worse" | "same within noise";
export interface Row {
  metric: string;
  a: number;
  b: number;
  delta: number;
  verdict: Verdict;
}

/** Every metric is lower-is-better. `delta` is the % change from a to b (b is the candidate). */
export function verdictRows(a: Record<string, number>, b: Record<string, number>, noise: number): Row[] {
  return Object.keys(a).map((metric) => {
    const x = a[metric] ?? 0;
    const y = b[metric] ?? 0;
    const delta = x === 0 ? (y === 0 ? 0 : Infinity) : ((y - x) / x) * 100;
    const verdict: Verdict = Math.abs(delta) <= noise ? "same within noise" : delta < 0 ? "better" : "worse";
    return { metric, a: x, b: y, delta, verdict };
  });
}

interface Report {
  server: string;
  rooms: number;
  members: number;
  durationS: number;
  samples: number;
  latencyMs: { count: number; p50: number; p95: number; p99: number; max: number };
  probeTimeouts: number;
  rssBytes: { idle: number; avg: number; peak: number };
  cpuPct: { avg: number; peak: number };
  frames: { sent: number; received: number };
  rateLimited: number;
  unexpectedCloses: number;
  serverExit: { code: number | null; signal: string | null; stderrTail: string };
  client: { cpuPct: number };
}

const flat = (r: Report): Record<string, number> => ({
  p50: r.latencyMs.p50,
  p95: r.latencyMs.p95,
  p99: r.latencyMs.p99,
  max: r.latencyMs.max,
  probeTimeouts: r.probeTimeouts,
  rssIdle: r.rssBytes.idle,
  rssAvg: r.rssBytes.avg,
  rssPeak: r.rssBytes.peak,
  cpuAvg: r.cpuPct.avg,
  cpuPeak: r.cpuPct.peak,
  rateLimited: r.rateLimited,
  unexpectedCloses: r.unexpectedCloses,
});

function table(a: Report, b: Report, noise: number): string {
  const rows = verdictRows(flat(a), flat(b), noise);
  const fmt = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(2));
  const head = ["metric", a.server, b.server, "delta", "verdict"];
  const body = rows.map((r) => [r.metric, fmt(r.a), fmt(r.b), Number.isFinite(r.delta) ? `${r.delta >= 0 ? "+" : ""}${r.delta.toFixed(1)}%` : "new", r.verdict]);
  const w = head.map((h, i) => Math.max(h.length, ...body.map((row) => (row[i] ?? "").length)));
  const line = (row: string[]): string => row.map((c, i) => c.padEnd(w[i] ?? 0)).join("  ");
  return [line(head), ...body.map(line)].join("\n");
}

// ---- the run ----

const startServer = (cmd: string, dbPath: string) =>
  startServerCommand(cmd, { HOST: "127.0.0.1", DB_PATH: dbPath, ADMIN_SOCKET: "off", METRICS_PORT: "off", SITE_ORIGIN, TRUST_PROXY: "off" });

interface Member {
  ws: WsConn | null;
  self: string;
  onPlayback: ((by: string, position: number) => void) | null;
}

async function run(args: Extract<Args, { mode: "run" }>): Promise<Report> {
  const dir = mkdtempSync(join(tmpdir(), "server-compare-"));
  const dbPath = join(dir, "omega.db");
  const embed = canonicalizeEmbed("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  if (embed === null) throw new Error("seed embed did not canonicalize");
  const db = openDatabase(dbPath);
  const store = new RoomStore(db);
  const ids = Array.from({ length: args.rooms }, (_, i) => `bench-${String(i)}`);
  for (const id of ids) {
    store.createRoom({ id, title: "bench", createdAt: Date.now(), layout: DEFAULT_LAYOUT, pinned: false });
    store.setEmbed(id, embed);
  }
  db.close();

  const { proc, port, stderr } = await startServer(args.server, dbPath);
  const pid = proc.pid;
  const exited = proc.exited;
  const clientCpu0 = process.cpuUsage();
  const wall0 = performance.now();
  const sockets: WsConn[] = [];
  const timers: Timer[] = [];
  let sent = 0;
  let received = 0;
  let rateLimited = 0;
  let unexpectedCloses = 0;
  let stopping = false;
  let probeTimeouts = 0;
  const lat: number[] = [];
  const samples: { rss: number; cpu: number }[] = [];
  try {
    await Bun.sleep(500);
    const idle = readProc(pid)?.rss ?? 0;
    let last = readProc(pid);
    let lastAt = performance.now();
    let hwm = idle;
    timers.push(
      setInterval(() => {
        const now = performance.now();
        const cur = readProc(pid);
        if (cur === null || last === null) return;
        samples.push({ rss: cur.rss, cpu: cpuPercent(last.ticks, cur.ticks, now - lastAt) });
        hwm = Math.max(hwm, cur.hwm);
        last = cur;
        lastAt = now;
      }, SAMPLE_MS),
    );

    const addrs = loopbackAddrs(args.rooms * args.members);
    let seq = 0;
    const connect = (room: string, i: number): Promise<Member> =>
      new Promise((resolve, reject) => {
        const addr = addrs[seq++ % addrs.length] ?? "127.0.0.1";
        const m: Member = { ws: null, self: "", onPlayback: null };
        const ws = new WsConn(port, addr, `/rooms/${room}/ws`, {
          open: () => {
            ws.send(JSON.stringify({ type: "join", nickname: `${room}-m${String(i)}`, avatar: i % 4 }));
            sent++;
          },
          text: (d) => {
            received++;
            if (d.startsWith('{"type":"playback"') && m.onPlayback !== null) {
              const p = (JSON.parse(d) as { playback: { by: string; position: number } }).playback;
              m.onPlayback(p.by, p.position);
            } else if (d.includes('"rate_limited"')) rateLimited++;
            else if (m.self === "" && d.startsWith('{"type":"snapshot"')) {
              m.self = (JSON.parse(d) as { self: string }).self;
              resolve(m);
            } else if (d.startsWith('{"type":"room-full"')) reject(new Error("room full"));
          },
          close: (why) => {
            if (!stopping) unexpectedCloses++;
            reject(new Error(`closed before join: ${why}`));
          },
        });
        m.ws = ws;
        sockets.push(ws);
      });

    // Join in waves of one member per room so every room fills at the same pace.
    const rooms: Member[][] = ids.map(() => []);
    for (let i = 0; i < args.members; i++) {
      const wave = await Promise.all(ids.map((id) => connect(id, i)));
      wave.forEach((m, r) => rooms[r]?.push(m));
    }

    const send = (m: Member, msg: object): void => {
      if (m.ws?.send(JSON.stringify(msg)) === true) sent++;
    };
    const every = (ms: number, offset: number, tick: () => void): void => {
      timers.push(setTimeout(() => timers.push(setInterval(tick, ms)), offset));
    };
    // Background traffic at the sustained limits, staggered across the second.
    let n = 0;
    for (const room of rooms)
      room.forEach((m, i) => {
        const off = (1000 * i) / room.length;
        every(1000 / CHAT_PER_SECOND, off, () => { send(m, { type: "chat", text: "member chat" }); });
        every(EMOTE_REFILL_MS, off, () => { send(m, { type: "emote", kind: EMOTE_KINDS[n++ % EMOTE_KINDS.length] }); });
        every(10_000, off * 10, () => { send(m, { type: "presence", away: n % 2 === 0 }); });
        every(7000, off * 7, () => { send(m, { type: "status", catching: n % 2 === 0 }); });
      });

    // Probes: per room, `probes` control seeks spread over the duration (never above the room's control rate).
    const gap = Math.max((1000 * 1.1) / ROOM_CONTROL_PER_SECOND, (args.duration * 1000) / args.probes);
    await Bun.sleep(2000); // let the room control bucket refill after the join storm
    const probeRoom = async (room: Member[], r: number): Promise<void> => {
      await Bun.sleep((gap * r) / rooms.length);
      const end = performance.now() + args.duration * 1000;
      for (let s = 0; s < args.probes && performance.now() < end; s++) {
        const actor = room[s % room.length];
        if (actor === undefined) return;
        const position = 2 * (s + 1);
        let pending = room.length;
        const t0 = performance.now();
        const done = new Promise<boolean>((resolve) => {
          const timeout = setTimeout(() => {
            resolve(false);
          }, PROBE_TIMEOUT_MS);
          for (const m of room)
            m.onPlayback = (by, pos) => {
              if (by !== actor.self || pos !== position) return;
              m.onPlayback = null;
              if (--pending === 0) {
                clearTimeout(timeout);
                resolve(true);
              }
            };
        });
        send(actor, { type: "control", url: embed.url, playing: s % 2 === 1, position });
        if (await done) lat.push(performance.now() - t0);
        else probeTimeouts++;
        await Bun.sleep(Math.max(0, gap - (performance.now() - t0)));
      }
    };
    await Promise.all(rooms.map(probeRoom));
    for (const t of timers) clearTimeout(t);
    stopping = true;
    for (const t of timers) clearInterval(t);
    for (const ws of sockets) ws.close();
    const dur = (performance.now() - wall0) / 1000;
    const cpu = process.cpuUsage(clientCpu0);
    proc.kill("SIGTERM");
    const code = await Promise.race([exited, Bun.sleep(10_000).then(() => -1)]);
    if (code === -1) proc.kill("SIGKILL");
    lat.sort((x, y) => x - y);
    const avg = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length);
    return {
      server: args.label,
      rooms: args.rooms,
      members: args.members,
      durationS: Math.round(dur * 10) / 10,
      samples: samples.length,
      latencyMs: { count: lat.length, p50: percentile(lat, 50), p95: percentile(lat, 95), p99: percentile(lat, 99), max: lat[lat.length - 1] ?? 0 },
      probeTimeouts,
      rssBytes: { idle, avg: avg(samples.map((s) => s.rss)), peak: Math.max(hwm, ...samples.map((s) => s.rss)) },
      cpuPct: { avg: avg(samples.map((s) => s.cpu)), peak: Math.max(0, ...samples.map((s) => s.cpu)) },
      frames: { sent, received },
      rateLimited,
      unexpectedCloses,
      serverExit: { code: proc.exitCode, signal: proc.signalCode, stderrTail: stderr().slice(-500) },
      client: { cpuPct: ((cpu.user + cpu.system) / 1000 / (dur * 1000)) * 100 },
    };
  } finally {
    stopping = true;
    for (const t of timers) {
      clearTimeout(t);
      clearInterval(t);
    }
    for (const ws of sockets) ws.close();
    if (proc.exitCode === null) proc.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.mode === "compare") {
      const read = async (f: string): Promise<Report> => (await Bun.file(f).json()) as Report;
      console.log(table(await read(args.a), await read(args.b), args.noise));
    } else {
      console.log(JSON.stringify(await run(args), null, 2));
    }
  } catch (err) {
    console.error(`server-compare: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
