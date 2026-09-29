/**
 * Relay latency probe (docs/perf-budgets.md: ≤ 50 ms for a control action, localhost).
 *
 * Joins `clients` sockets to a room. For each sample, one actor sends a `sit` (then, on the
 * next sample, stands up again), and the sample is the time until the last socket (actor
 * included) receives the `seat-changed`. Actors rotate through the sockets so no one socket
 * exceeds the server's per-socket rate limit (a burst of 20). Falls back to `chat` if every
 * seat is taken. Leaves the room as it found it.
 *
 * CLI: `bun run --filter @omega/server bench:relay -- --url ws://127.0.0.1:8787/rooms/lobby/ws`
 * prints the result as JSON and exits 1 when p95 exceeds `--budget` (default 50).
 */
import { parseArgs } from "node:util";
import { parseServerMessage, type SeatIndex, type ServerMessage } from "@omega/shared";

export interface RelayLatencyOptions {
  url: string;
  clients?: number;
  samples?: number;
  /** Sent as the Origin header; needed when the server is reached from a browser-only origin policy. */
  origin?: string;
  timeoutMs?: number;
}

export interface RelayLatencyResult {
  clients: number;
  samples: number;
  action: "sit" | "chat";
  p50: number;
  p95: number;
  max: number;
}

interface Probe {
  socket: WebSocket;
  self: string;
  firstFreeSeat: SeatIndex | null;
  onMessage: ((msg: ServerMessage) => void) | null;
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      reject(new Error(`relay-latency: timed out waiting for ${what}`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(t);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(t);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/** Every socket is recorded in `sockets` as soon as it exists, so the caller can always close it. */
function connect(url: string, index: number, origin: string | undefined, sockets: WebSocket[]): Promise<Probe> {
  return new Promise((resolve, reject) => {
    const socket = origin === undefined ? new WebSocket(url) : new WebSocket(url, { headers: { Origin: origin } });
    sockets.push(socket);
    const probe: Probe = { socket, self: "", firstFreeSeat: null, onMessage: null };
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "join", nickname: `probe-${String(index)}`, avatar: index % 4 }));
    });
    socket.addEventListener("message", (e: MessageEvent) => {
      const msg = typeof e.data === "string" ? parseServerMessage(e.data) : null;
      if (msg === null) return;
      if (msg.type === "snapshot" && probe.self === "") {
        probe.self = msg.self;
        const free = msg.room.seats.indexOf(null);
        probe.firstFreeSeat = free === -1 ? null : (free);
        resolve(probe);
      } else if (msg.type === "room-full") {
        reject(new Error("relay-latency: room is full"));
      }
      probe.onMessage?.(msg);
    });
    socket.addEventListener("error", () => {
      reject(new Error("relay-latency: connection refused or failed (origin, per-address cap, or server down?)"));
    });
    socket.addEventListener("close", (e: CloseEvent) => {
      reject(new Error(`relay-latency: server closed the socket before it joined (code ${String(e.code)})`));
    });
  });
}

export async function measureRelayLatency(opts: RelayLatencyOptions): Promise<RelayLatencyResult> {
  const clients = opts.clients ?? 25;
  const samples = opts.samples ?? 50;
  const timeoutMs = opts.timeoutMs ?? 2000;
  if (!Number.isInteger(clients) || clients < 1) throw new Error("relay-latency: clients must be an integer ≥ 1");
  if (!Number.isInteger(samples) || samples < 1) throw new Error("relay-latency: samples must be an integer ≥ 1");
  const probes: Probe[] = [];
  const sockets: WebSocket[] = [];
  try {
    // Join one at a time so the actor's snapshot is taken after everyone else is in.
    for (let i = 0; i < clients; i++) {
      probes.push(await withTimeout(connect(opts.url, i, opts.origin, sockets), timeoutMs, "join"));
    }
    const last = probes[probes.length - 1];
    if (last === undefined) throw new Error("relay-latency: no clients joined");
    const seat = last.firstFreeSeat;
    const action = seat === null ? "chat" : "sit";
    let actor = last;

    const times: number[] = [];
    for (let s = 0; s < samples; s++) {
      const target = s % 2 === 0 ? seat : null;
      actor = probes[(action === "sit" ? Math.floor(s / 2) : s) % probes.length] ?? last;
      let pending = probes.length;
      const self = actor.self;
      const done = new Promise<void>((resolve) => {
        for (const p of probes) {
          p.onMessage = (msg) => {
            const hit =
              action === "sit"
                ? msg.type === "seat-changed" && msg.memberId === self && msg.seat === target
                : msg.type === "chat" && msg.memberId === self;
            if (!hit) return;
            p.onMessage = null;
            if (--pending === 0) resolve();
          };
        }
      });
      const t0 = performance.now();
      actor.socket.send(
        JSON.stringify(action === "sit" ? { type: "sit", seat: target } : { type: "chat", text: `probe ${String(s)}` }),
      );
      await withTimeout(done, timeoutMs, `sample ${String(s)}`);
      times.push(performance.now() - t0);
    }
    if (action === "sit" && samples % 2 === 1) actor.socket.send(JSON.stringify({ type: "sit", seat: null }));

    times.sort((a, b) => a - b);
    return {
      clients,
      samples,
      action,
      p50: percentile(times, 50),
      p95: percentile(times, 95),
      max: times[times.length - 1] ?? 0,
    };
  } finally {
    await Promise.all(
      sockets.map(
        (socket) =>
          new Promise<void>((resolve) => {
            if (socket.readyState === WebSocket.CLOSED) {
              resolve();
              return;
            }
            socket.addEventListener("close", () => {
              resolve();
            });
            socket.close();
          }),
      ),
    );
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      url: { type: "string", default: "ws://127.0.0.1:8787/rooms/lobby/ws" },
      clients: { type: "string", default: "25" },
      samples: { type: "string", default: "50" },
      budget: { type: "string", default: "50" },
      origin: { type: "string" },
    },
  });
  const result = await measureRelayLatency({
    url: values.url,
    clients: Number(values.clients),
    samples: Number(values.samples),
    ...(values.origin === undefined ? {} : { origin: values.origin }),
  });
  const budget = Number(values.budget);
  console.log(JSON.stringify({ ...result, budget, pass: result.p95 <= budget }));
  if (result.p95 > budget) process.exit(1);
}
