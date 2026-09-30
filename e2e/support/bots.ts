// Cheap room members: raw WebSockets opened from a page on the site origin (so the server's Origin check passes).
// Use them to fill seats or the room without paying for a full site client each.
import type { Browser, BrowserContext } from "@playwright/test";
import { URLS } from "./apps";
import { watchCsp } from "./csp";

export interface BotSpec {
  readonly nickname: string;
  /** Seat to sit on after joining; omit to stay standing. */
  readonly seat?: number;
}

export interface Bots {
  /** How many bots got a snapshot (joined) before the first `room-full`. */
  readonly joined: number;
  /** True when a bot was turned away with `room-full`. */
  readonly sawRoomFull: boolean;
  readonly close: () => Promise<void>;
}

export function socketUrl(roomId: string): string {
  const u = new URL(URLS.server);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = `/rooms/${roomId}/ws`;
  return u.href;
}

/** Joins `specs` one by one; stops at the first `room-full`. Bots stay connected until `close()`. */
export async function spawnBots(browser: Browser, roomId: string, specs: readonly BotSpec[]): Promise<Bots> {
  const context: BrowserContext = await watchCsp(await browser.newContext());
  const page = await context.newPage();
  await page.goto(URLS.web);
  const result = await page.evaluate(
    async ({ url, specs }) => {
      const kept: WebSocket[] = [];
      Object.assign(window, { omegaBots: kept });
      let joined = 0;
      for (const spec of specs) {
        const ws = new WebSocket(url);
        const outcome = await new Promise<"joined" | "full" | "closed">((resolve) => {
          ws.addEventListener("open", () => {
            ws.send(JSON.stringify({ type: "join", nickname: spec.nickname, avatar: joined % 4 }));
          });
          ws.addEventListener("message", (ev: MessageEvent<unknown>) => {
            const msg: unknown = typeof ev.data === "string" ? JSON.parse(ev.data) : null;
            const type = typeof msg === "object" && msg !== null && "type" in msg ? msg.type : null;
            if (type === "snapshot") resolve("joined");
            else if (type === "room-full") resolve("full");
          });
          ws.addEventListener("close", () => {
            resolve("closed");
          });
        });
        if (outcome !== "joined") return { joined, sawRoomFull: outcome === "full" };
        joined++;
        kept.push(ws);
        if (spec.seat !== undefined) ws.send(JSON.stringify({ type: "sit", seat: spec.seat }));
      }
      return { joined, sawRoomFull: false };
    },
    { url: socketUrl(roomId), specs },
  );
  return { ...result, close: () => context.close() };
}

/** The room as the server sees it: joins as a throwaway observer, then leaves. Returns the raw snapshot frame. */
export async function rawSnapshot(browser: Browser, roomId: string): Promise<string> {
  const context = await watchCsp(await browser.newContext());
  try {
    const page = await context.newPage();
    await page.goto(URLS.web);
    return await page.evaluate(
      (url) =>
        new Promise<string>((resolve, reject) => {
          const ws = new WebSocket(url);
          ws.addEventListener("open", () => {
            ws.send(JSON.stringify({ type: "join", nickname: "observer", avatar: 0 }));
          });
          ws.addEventListener("message", (ev: MessageEvent<unknown>) => {
            if (typeof ev.data !== "string" || !ev.data.includes('"snapshot"')) return;
            ws.close();
            resolve(ev.data);
          });
          ws.addEventListener("close", () => {
            reject(new Error("closed before snapshot"));
          });
        }),
      socketUrl(roomId),
    );
  } finally {
    await context.close();
  }
}

export interface TrafficOptions {
  readonly bots: number;
  readonly nicknamePrefix: string;
  /** Bot i sits on `fixedSeats[i]` right after joining and stays there (out of the probe rotation and churn). */
  readonly fixedSeats?: readonly number[];
  /** Each bot chats about once per this interval (one round-robin timer across the live bots). */
  readonly chatEveryMs: number;
  /**
   * Relay-latency samples: every `everyMs` one bot (round-robin) sits on `seat`, and on the next tick stands up again.
   * A sample is send → that `seat-changed` reaching every bot, sender included. All bots share one page and one event
   * loop, so it's the slowest of the receivers including client-side queueing: stricter than one client's view.
   * A sample that doesn't complete in `SAMPLE_TIMEOUT_MS` counts as `dropped` and as a latency of that timeout.
   */
  readonly probe: { readonly seat: number; readonly everyMs: number };
  /** One bot leaves and a fresh one joins per interval (member-left / member-joined churn). */
  readonly churnEveryMs?: number;
}

export interface TrafficStats {
  /** Current room size as bot #1 (which never churns) sees it. */
  readonly members: number;
  readonly chats: number;
  readonly seatChanges: number;
  readonly joins: number;
  /** Relay-latency samples in ms, oldest first. */
  readonly latencies: readonly number[];
  /** Samples that never reached every bot within the timeout. */
  readonly dropped: number;
  /** Server `error` codes any bot got. */
  readonly errors: readonly string[];
}

export interface Traffic {
  readonly stats: () => Promise<TrafficStats>;
  /** Stops the traffic, closes the bots and returns the final stats. */
  readonly stop: () => Promise<TrafficStats>;
}

const SAMPLE_TIMEOUT_MS = 2000;

const isNumberArray = (x: unknown): x is number[] => Array.isArray(x) && x.every((n) => typeof n === "number");
const isStringArray = (x: unknown): x is string[] => Array.isArray(x) && x.every((n) => typeof n === "string");

function parseStats(x: unknown): TrafficStats {
  if (typeof x !== "object" || x === null) throw new Error(`traffic: bad stats ${JSON.stringify(x)}`);
  const num = (k: string): number => {
    const v: unknown = Reflect.get(x, k);
    if (typeof v !== "number") throw new Error(`traffic: stats.${k} is not a number`);
    return v;
  };
  const latencies: unknown = Reflect.get(x, "latencies");
  const errors: unknown = Reflect.get(x, "errors");
  if (!isNumberArray(latencies) || !isStringArray(errors)) throw new Error("traffic: bad stats arrays");
  return { members: num("members"), chats: num("chats"), seatChanges: num("seatChanges"), joins: num("joins"), dropped: num("dropped"), latencies, errors };
}

/**
 * `bots` raw-socket members generating steady room traffic (chat, seat changes, optional churn) while measuring relay
 * latency. Each bot stays well under the server's 10 msg/s per-socket limit. Resolves once every bot has joined.
 */
export async function startTraffic(browser: Browser, roomId: string, opts: TrafficOptions): Promise<Traffic> {
  const context = await watchCsp(await browser.newContext());
  const page = await context.newPage();
  await page.goto(URLS.web);
  await page.evaluate(
    async ({ url, o, timeoutMs }) => {
      interface Bot { ws: WebSocket; self: string; open: boolean }
      /** In flight: `actor` asked for `seat`; done when every bot in `waiting` saw that exact seat-changed. */
      interface Sample { start: number; waiting: Set<Bot>; timer: number; actor: string; seat: number | null }
      const bots: Bot[] = [];
      const errors: string[] = [];
      const latencies: number[] = [];
      let members = 0, chats = 0, seatChanges = 0, joins = 0, dropped = 0, serial = 0, next = 0, chatNext = 0;
      let sample: Sample | null = null;
      /** Who holds the probe seat, from the server's seat-changed / member-left stream (not from what we sent). */
      let holder: string | null = null;

      const finish = (s: Sample, latency: number | null): void => {
        clearTimeout(s.timer);
        if (latency !== null) latencies.push(latency);
        if (sample === s) sample = null;
      };
      const join = (fixedSeat: number | undefined): Promise<Bot> =>
        new Promise((resolve, reject) => {
          const n = serial++;
          const ws = new WebSocket(url);
          const bot: Bot = { ws, self: "", open: false };
          const observer = (): boolean => bots[0] === bot;
          ws.addEventListener("open", () => {
            ws.send(JSON.stringify({ type: "join", nickname: `${o.nicknamePrefix}-${String(n + 1)}`, avatar: n % 4 }));
          });
          ws.addEventListener("message", (ev: MessageEvent<unknown>) => {
            const msg: unknown = typeof ev.data === "string" ? JSON.parse(ev.data) : null;
            if (typeof msg !== "object" || msg === null || !("type" in msg)) return;
            const memberId = "memberId" in msg && typeof msg.memberId === "string" ? msg.memberId : null;
            if (msg.type === "snapshot" && "self" in msg && typeof msg.self === "string" && "room" in msg) {
              const room = msg.room;
              if (observer() && typeof room === "object" && room !== null && "members" in room && Array.isArray(room.members)) members = room.members.length;
              bot.self = msg.self;
              bot.open = true;
              joins++;
              if (fixedSeat !== undefined) ws.send(JSON.stringify({ type: "sit", seat: fixedSeat }));
              resolve(bot);
            } else if (msg.type === "room-full") reject(new Error("room-full"));
            else if (msg.type === "chat") chats++;
            else if (msg.type === "error" && "code" in msg) errors.push(String(msg.code));
            else if (msg.type === "member-joined" && observer()) members++;
            else if (msg.type === "member-left") {
              if (observer()) members--;
              if (memberId !== null && memberId === holder) holder = null;
            } else if (msg.type === "seat-changed" && "seat" in msg) {
              seatChanges++;
              if (msg.seat === o.probe.seat) holder = memberId;
              else if (memberId !== null && memberId === holder) holder = null;
              const s = sample;
              if (s !== null && memberId === s.actor && msg.seat === s.seat) {
                s.waiting.delete(bot);
                if (s.waiting.size === 0) finish(s, performance.now() - s.start);
              }
            }
          });
          ws.addEventListener("close", () => {
            bot.open = false;
            if (bot.self === "") reject(new Error("closed before snapshot"));
          });
          bots.push(bot);
        });

      for (let i = 0; i < o.bots; i++) await join(o.fixedSeats?.[i]);

      const live = (): Bot[] => bots.filter((b) => b.open);
      const fixed = new Set(bots.slice(0, o.fixedSeats?.length ?? 0));
      const timers: number[] = [];
      timers.push(
        window.setInterval(() => {
          const everyone = live();
          const bot = everyone[chatNext++ % Math.max(1, everyone.length)];
          bot?.ws.send(JSON.stringify({ type: "chat", text: `load ${String(chatNext)}` }));
        }, o.chatEveryMs / o.bots),
      );
      timers.push(
        window.setInterval(() => {
          if (sample !== null) return;
          const everyone = live();
          const seated = everyone.find((b) => b.self === holder);
          // Someone else (not one of our bots) holds the probe seat: wait for them to stand up.
          if (holder !== null && seated === undefined) return;
          const rotation = everyone.filter((b) => !fixed.has(b));
          const actor = seated ?? rotation[next++ % Math.max(1, rotation.length)];
          if (actor === undefined) return;
          const seat = seated === undefined ? o.probe.seat : null;
          const s: Sample = { start: performance.now(), waiting: new Set(everyone), actor: actor.self, seat, timer: 0 };
          s.timer = window.setTimeout(() => {
            dropped++;
            finish(s, timeoutMs);
          }, timeoutMs);
          sample = s;
          actor.ws.send(JSON.stringify({ type: "sit", seat }));
        }, o.probe.everyMs),
      );
      if (o.churnEveryMs !== undefined) {
        timers.push(
          window.setInterval(() => {
            // Never the probe-seat holder or an in-flight sample's actor, so churn can't stall or fake a sample.
            const leaver = live().find((b) => !fixed.has(b) && b.self !== holder && b.self !== sample?.actor);
            if (leaver === undefined) return;
            leaver.ws.close();
            const s = sample;
            if (s !== null) {
              s.waiting.delete(leaver);
              // Everyone left already has it, but the time now includes the departure: discard rather than record.
              if (s.waiting.size === 0) finish(s, null);
            }
            void join(undefined).catch((e: unknown) => errors.push(String(e)));
          }, o.churnEveryMs),
        );
      }
      const stats = () => ({ members, chats, seatChanges, joins, latencies: [...latencies], dropped, errors: [...errors] });
      Object.assign(window, {
        omegaTraffic: {
          stats,
          stop: () => {
            for (const t of timers) clearInterval(t);
            if (sample !== null) clearTimeout(sample.timer);
            for (const b of bots) b.ws.close();
            return stats();
          },
        },
      });
    },
    { url: socketUrl(roomId), o: opts, timeoutMs: SAMPLE_TIMEOUT_MS },
  );
  const call = async (fn: "stats" | "stop"): Promise<TrafficStats> =>
    parseStats(
      await page.evaluate((f): unknown => {
        const t: unknown = Reflect.get(window, "omegaTraffic");
        const g: unknown = typeof t === "object" && t !== null ? Reflect.get(t, f) : null;
        if (typeof g !== "function") throw new Error("traffic not running");
        return Reflect.apply(g, t, []);
      }, fn),
    );
  return {
    stats: () => call("stats"),
    stop: async () => {
      const s = await call("stop");
      await context.close();
      return s;
    },
  };
}
