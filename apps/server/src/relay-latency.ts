/**
 * Relay latency probe (docs/perf-budgets.md: ≤ 50 ms for a control action, localhost).
 *
 * Joins `clients` sockets to a room. For each sample, one actor sends a `sit` (then, on the
 * next sample, stands up again), and the sample is the time until the last socket (actor
 * included) receives the `seat-changed`. Actors rotate through the sockets so no one socket
 * exceeds the server's per-socket rate limit (a burst of 20). Falls back to `chat` if every
 * seat is taken. Leaves the room as it found it.
 *
 * With `action: "control"` (the room must have an embed) each sample is a `control` seek to a
 * fresh position instead, timed until every socket receives the matching `playback`. Actors
 * rotate so no socket exceeds its control limit (a burst of 4), and samples are paced to the room's
 * control limit (a burst of 8, then 4/s) after a 2 s wait for that bucket to refill, so 50 samples take about
 * 13 s. Afterwards it sends one more
 * control restoring the playback it found, extrapolated with the local clock.
 *
 * With `flood`, one of the `clients` sockets is an attacker instead of a probe: it sends chat at 10× the
 * per-socket limit (100/s) for the whole run and rejoins whenever the server closes it (threat model §8).
 * Every other member also chats at the server's sustained chat rate and emotes at the sustained emote rate
 * (legitimate traffic at its limits).
 * Samples are then spread 20 ms apart, so they span the attacker's closes and rejoins. The result counts
 * the attacker's `rate_limited` notices and close codes, the members' emotes that came back as `emoted`, and any
 * `rate_limited` a member got (should be 0).
 *
 * CLI: `bun run --filter @omega/server bench:relay -- --url ws://127.0.0.1:8787/rooms/lobby/ws [--action control] [--flood]`
 * prints the result as JSON and exits 1 when p95 exceeds `--budget` (default 50).
 */
import { parseArgs } from "node:util";
import { EMOTE_KINDS, EMOTE_REFILL_MS, parseServerMessage, type AnyEmbed, type PlaybackState, type SeatIndex, type ServerMessage } from "@omega/shared";
import { expectedPosition } from "./playback";
import { TokenBucket } from "./rate-limit";
import { CHAT_PER_SECOND, CONTROL_BURST, ROOM_CONTROL_BURST, ROOM_CONTROL_PER_SECOND } from "./ws";

export interface RelayLatencyOptions {
  url: string;
  clients?: number;
  samples?: number;
  /** Sent as the Origin header; needed when the server is reached from a browser-only origin policy. */
  origin?: string;
  timeoutMs?: number;
  /** `seat` (default): sit/stand, or chat when the seats are full. `control`: seek via `control`. */
  action?: "seat" | "control";
  /** One of `clients` floods chat for the whole run instead of probing. */
  flood?: boolean;
}

export interface RelayLatencyResult {
  clients: number;
  flood: boolean;
  samples: number;
  action: "sit" | "chat" | "control";
  p50: number;
  p95: number;
  max: number;
  /**
   * Flood only: the members' background chat and emotes sent, their emotes that came back as `emoted`,
   * and `rate_limited` notices any member received.
   */
  members?: { chats: number; emotes: number; emoted: number; rateLimited: number };
  /** Flood only: frames the attacker sent, its `rate_limited` notices, and its close codes (count per code). */
  attacker?: { sent: number; rateLimited: number; closes: Record<string, number> };
}

interface AttackerStats {
  sent: number;
  rateLimited: number;
  closes: Record<string, number>;
}

interface Probe {
  socket: WebSocket;
  self: string;
  firstFreeSeat: SeatIndex | null;
  embed: AnyEmbed | null;
  playback: PlaybackState | null;
  onMessage: ((msg: ServerMessage) => void) | null;
  /** `rate_limited` notices this socket received. */
  rateLimited: number;
  /** This member's own emotes relayed back to it. */
  emoted: number;
}

/** The attacker's pace: 10× the server's per-socket limit of 10/s. */
const FLOOD_INTERVAL_MS = 10;
/** Under flood, samples are spread out so the run spans the attacker's closes and rejoins (~1 s for 50). */
const FLOOD_SAMPLE_GAP_MS = 20;

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
    const probe: Probe = { socket, self: "", firstFreeSeat: null, embed: null, playback: null, onMessage: null, rateLimited: 0, emoted: 0 };
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "join", nickname: `probe-${String(index)}`, avatar: index % 4 }));
    });
    socket.addEventListener("message", (e: MessageEvent) => {
      const msg = typeof e.data === "string" ? parseServerMessage(e.data) : null;
      if (msg === null) return;
      if (msg.type === "error" && msg.code === "rate_limited") probe.rateLimited++;
      if (msg.type === "emoted" && msg.memberId === probe.self) probe.emoted++;
      if (msg.type === "snapshot" && probe.self === "") {
        probe.self = msg.self;
        const free = msg.room.seats.indexOf(null);
        probe.firstFreeSeat = free === -1 ? null : (free);
        probe.embed = msg.room.embed;
        probe.playback = msg.room.playback ?? null;
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

/** A socket that joins and floods chat until stopped, rejoining after every close. */
function startFlooder(url: string, origin: string | undefined, sockets: WebSocket[], stats: AttackerStats): () => void {
  let stopped = false;
  let timer: Timer | null = null;
  const open = (): void => {
    const socket = origin === undefined ? new WebSocket(url) : new WebSocket(url, { headers: { Origin: origin } });
    sockets.push(socket);
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "join", nickname: "flooder", avatar: 0 }));
      let n = 0;
      timer = setInterval(() => {
        if (socket.readyState !== WebSocket.OPEN) return;
        socket.send(JSON.stringify({ type: "chat", text: `flood ${String(n++)}` }));
        stats.sent++;
      }, FLOOD_INTERVAL_MS);
    });
    socket.addEventListener("message", (e: MessageEvent) => {
      const msg = typeof e.data === "string" ? parseServerMessage(e.data) : null;
      if (msg?.type === "error" && msg.code === "rate_limited") stats.rateLimited++;
    });
    socket.addEventListener("close", (e: CloseEvent) => {
      if (timer !== null) clearInterval(timer);
      timer = null;
      if (stopped) return;
      const code = String(e.code);
      stats.closes[code] = (stats.closes[code] ?? 0) + 1;
      open();
    });
  };
  open();
  return () => {
    stopped = true;
    if (timer !== null) clearInterval(timer);
  };
}

export async function measureRelayLatency(opts: RelayLatencyOptions): Promise<RelayLatencyResult> {
  const clients = opts.clients ?? 25;
  const samples = opts.samples ?? 50;
  const timeoutMs = opts.timeoutMs ?? 2000;
  if (!Number.isInteger(clients) || clients < 1) throw new Error("relay-latency: clients must be an integer ≥ 1");
  if (!Number.isInteger(samples) || samples < 1) throw new Error("relay-latency: samples must be an integer ≥ 1");
  const flood = opts.flood ?? false;
  if (flood && clients < 2) throw new Error("relay-latency: flood needs clients ≥ 2 (one is the attacker)");
  const probes: Probe[] = [];
  const sockets: WebSocket[] = [];
  let stopFlood: (() => void) | null = null;
  const attacker: AttackerStats = { sent: 0, rateLimited: 0, closes: {} };
  const chatTimers: Timer[] = [];
  let memberChats = 0;
  let memberEmotes = 0;
  try {
    // The attacker joins first, so the probes' room is already under flood.
    if (flood) stopFlood = startFlooder(opts.url, opts.origin, sockets, attacker);
    // Join one at a time so the actor's snapshot is taken after everyone else is in.
    for (let i = 0; i < (flood ? clients - 1 : clients); i++) {
      probes.push(await withTimeout(connect(opts.url, i, opts.origin, sockets), timeoutMs, "join"));
    }
    const last = probes[probes.length - 1];
    if (last === undefined) throw new Error("relay-latency: no clients joined");
    const seat = last.firstFreeSeat;
    const action = opts.action === "control" ? "control" : seat === null ? "chat" : "sit";
    const url = last.embed?.url ?? null;
    const found = last.playback;
    if (action === "control") {
      if (url === null) throw new Error("relay-latency: control mode needs an embed in the room");
      if (samples + 1 > probes.length * CONTROL_BURST) {
        throw new Error(`relay-latency: control mode needs clients ≥ (samples + 1) / ${String(CONTROL_BURST)}`);
      }
    }
    if (flood) {
      // Every member chats and emotes at the sustained rates, staggered, for the rest of the run.
      const every = (ms: number, i: number, tick: () => void): void => {
        chatTimers.push(setTimeout(() => chatTimers.push(setInterval(tick, ms)), (ms * i) / probes.length));
      };
      probes.forEach((p, i) => {
        every(1000 / CHAT_PER_SECOND, i, () => {
          if (p.socket.readyState !== WebSocket.OPEN) return;
          p.socket.send(JSON.stringify({ type: "chat", text: "member chat" }));
          memberChats++;
        });
        every(EMOTE_REFILL_MS, i, () => {
          if (p.socket.readyState !== WebSocket.OPEN) return;
          p.socket.send(JSON.stringify({ type: "emote", kind: EMOTE_KINDS[memberEmotes % EMOTE_KINDS.length] }));
          memberEmotes++;
        });
      });
    }
    let actor = last;
    // Mirrors the server's room control bucket, one token short so the server always has one to spare.
    const roomControl = new TokenBucket(ROOM_CONTROL_BURST - 1, ROOM_CONTROL_PER_SECOND);
    const paceControl = async (): Promise<void> => {
      if (action !== "control") return;
      while (!roomControl.take()) await Bun.sleep(roomControl.retryAfterMs());
    };
    // The server's room bucket may still be drained by an earlier run (or a member's seeks): let it refill first.
    if (action === "control") await Bun.sleep((1000 * ROOM_CONTROL_BURST) / ROOM_CONTROL_PER_SECOND);

    const times: number[] = [];
    for (let s = 0; s < samples; s++) {
      const target = s % 2 === 0 ? seat : null;
      actor = probes[(action === "sit" ? Math.floor(s / 2) : s) % probes.length] ?? last;
      // Unique per sample, so each hit is this sample's playback; +2 s steps are always seeks.
      const position = 2 * (s + 1);
      let pending = probes.length;
      const self = actor.self;
      const done = new Promise<void>((resolve) => {
        for (const p of probes) {
          p.onMessage = (msg) => {
            const hit =
              action === "sit"
                ? msg.type === "seat-changed" && msg.memberId === self && msg.seat === target
                : action === "control"
                  ? msg.type === "playback" && msg.playback.by === self && msg.playback.position === position
                  : msg.type === "chat" && msg.memberId === self && msg.text === `probe ${String(s)}`;
            if (!hit) return;
            p.onMessage = null;
            if (--pending === 0) resolve();
          };
        }
      });
      await paceControl();
      if (flood) await Bun.sleep(FLOOD_SAMPLE_GAP_MS);
      const t0 = performance.now();
      actor.socket.send(
        JSON.stringify(
          action === "sit"
            ? { type: "sit", seat: target }
            : action === "control"
              ? { type: "control", url, playing: s % 2 === 1, position }
              : { type: "chat", text: `probe ${String(s)}` },
        ),
      );
      await withTimeout(done, timeoutMs, `sample ${String(s)}`);
      times.push(performance.now() - t0);
    }
    if (action === "sit" && samples % 2 === 1) actor.socket.send(JSON.stringify({ type: "sit", seat: null }));
    if (action === "control" && found !== null) {
      const restorer = probes[samples % probes.length] ?? last;
      const restored = new Promise<void>((resolve) => {
        restorer.onMessage = (msg) => {
          if (msg.type === "playback" && msg.playback.by === restorer.self) resolve();
        };
      });
      await paceControl();
      const position = expectedPosition(found, Date.now());
      restorer.socket.send(JSON.stringify({ type: "control", url, playing: found.playing, position }));
      await withTimeout(restored, timeoutMs, "restore");
    }

    times.sort((a, b) => a - b);
    return {
      clients,
      flood,
      samples,
      action,
      p50: percentile(times, 50),
      p95: percentile(times, 95),
      max: times[times.length - 1] ?? 0,
      ...(flood
        ? {
            members: {
              chats: memberChats,
              emotes: memberEmotes,
              emoted: probes.reduce((n, p) => n + p.emoted, 0),
              rateLimited: probes.reduce((n, p) => n + p.rateLimited, 0),
            },
            attacker: { ...attacker, closes: { ...attacker.closes } },
          }
        : {}),
    };
  } finally {
    stopFlood?.();
    for (const t of chatTimers) clearTimeout(t);
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
      action: { type: "string", default: "seat" },
      flood: { type: "boolean", default: false },
    },
  });
  const result = await measureRelayLatency({
    url: values.url,
    clients: Number(values.clients),
    samples: Number(values.samples),
    action: values.action === "control" ? "control" : "seat",
    flood: values.flood,
    ...(values.origin === undefined ? {} : { origin: values.origin }),
  });
  const budget = Number(values.budget);
  console.log(JSON.stringify({ ...result, budget, pass: result.p95 <= budget }));
  if (result.p95 > budget) process.exit(1);
}
