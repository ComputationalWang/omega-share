// Cheap room members: raw WebSockets opened from a page on the site origin (so the server's Origin check passes).
// Use them to fill seats or the room without paying for a full site client each.
import type { Browser, BrowserContext } from "@playwright/test";
import { URLS } from "./apps";

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
  const context: BrowserContext = await browser.newContext();
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
  const context = await browser.newContext();
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
  /** Bot i sits on `fixedSeats[i]` right after joining and stays there. */
  readonly fixedSeats?: readonly number[];
  /** Each bot chats once per this interval (staggered across bots). */
  readonly chatEveryMs: number;
  /**
   * Relay-latency samples: every `everyMs` one bot (round-robin) sits on `seat`, next tick stands up again. A sample is
   * send → the `seat-changed` reaching every bot, sender included. All bots share one page, so one clock.
   */
  readonly probe: { readonly seat: number; readonly everyMs: number };
  /** One bot leaves and a fresh one joins per interval (member-left / member-joined churn). */
  readonly churnEveryMs?: number;
}

export interface TrafficStats {
  /** Room size in the latest snapshot any bot got. */
  readonly members: number;
  readonly chats: number;
  readonly seatChanges: number;
  readonly joins: number;
  /** Relay-latency samples in ms. */
  readonly latencies: readonly number[];
  /** Samples that never reached every bot within 2 s, and server `error` codes. */
  readonly dropped: number;
  readonly errors: readonly string[];
}

export interface Traffic {
  readonly stats: () => Promise<TrafficStats>;
  /** Stops the traffic, closes the bots and returns the final stats. */
  readonly stop: () => Promise<TrafficStats>;
}

/**
 * `bots` raw-socket members generating steady room traffic (chat, seat changes, optional churn) while measuring relay
 * latency. Each bot stays under the server's 10 msg/s per-socket limit. Resolves once every bot has joined.
 */
export async function startTraffic(browser: Browser, roomId: string, opts: TrafficOptions): Promise<Traffic> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(URLS.web);
  await page.evaluate(
    async ({ url, o }) => {
      interface Bot { ws: WebSocket; self: string; open: boolean }
      interface Sample { start: number; waiting: Set<Bot>; timer: number; actor: string }
      const bots: Bot[] = [];
      const errors: string[] = [];
      const latencies: number[] = [];
      let members = 0, chats = 0, seatChanges = 0, joins = 0, dropped = 0, serial = 0;
      let sample: Sample | null = null;
      let occupant: Bot | null = null;
      let next = 0;
      let chatNext = 0;

      const settle = (bot: Bot): void => {
        if (sample === null) return;
        sample.waiting.delete(bot);
        if (sample.waiting.size > 0) return;
        latencies.push(performance.now() - sample.start);
        clearTimeout(sample.timer);
        sample = null;
      };
      const join = (fixedSeat: number | undefined): Promise<Bot> =>
        new Promise((resolve, reject) => {
          const n = serial++;
          const ws = new WebSocket(url);
          const bot: Bot = { ws, self: "", open: false };
          ws.addEventListener("open", () => {
            ws.send(JSON.stringify({ type: "join", nickname: `${o.nicknamePrefix}-${String(n + 1)}`, avatar: n % 4 }));
          });
          ws.addEventListener("message", (ev: MessageEvent<unknown>) => {
            const msg: unknown = typeof ev.data === "string" ? JSON.parse(ev.data) : null;
            if (typeof msg !== "object" || msg === null || !("type" in msg)) return;
            if (msg.type === "snapshot" && "self" in msg && typeof msg.self === "string" && "room" in msg) {
              const room = msg.room;
              if (typeof room === "object" && room !== null && "members" in room && Array.isArray(room.members)) members = room.members.length;
              bot.self = msg.self;
              bot.open = true;
              joins++;
              if (fixedSeat !== undefined) ws.send(JSON.stringify({ type: "sit", seat: fixedSeat }));
              resolve(bot);
            } else if (msg.type === "room-full") reject(new Error("room-full"));
            else if (msg.type === "chat") chats++;
            else if (msg.type === "error" && "code" in msg) errors.push(String(msg.code));
            else if (msg.type === "seat-changed" && "seat" in msg) {
              seatChanges++;
              if ("memberId" in msg && msg.memberId === sample?.actor) settle(bot);
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
      // Bots holding a fixed seat stay out of the probe rotation and churn, so their seats never move.
      const fixed = new Set(bots.slice(0, o.fixedSeats?.length ?? 0));
      const timers: number[] = [];
      // One round-robin chat timer, so bots that churn in chat too; each bot still chats about once per chatEveryMs.
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
          if (occupant !== null && !occupant.open) occupant = null;
          const rotation = everyone.filter((b) => !fixed.has(b));
          const actor = occupant ?? rotation[next++ % Math.max(1, rotation.length)];
          if (actor === undefined) return;
          const standing = occupant !== null;
          occupant = standing ? null : actor;
          const timer = window.setTimeout(() => {
            dropped++;
            sample = null;
          }, 2000);
          sample = { start: performance.now(), waiting: new Set(everyone), timer, actor: actor.self };
          actor.ws.send(JSON.stringify({ type: "sit", seat: standing ? null : o.probe.seat }));
        }, o.probe.everyMs),
      );
      if (o.churnEveryMs !== undefined) {
        timers.push(
          window.setInterval(() => {
            // Leave with a bot that isn't holding a seat, then join a fresh one in its place.
            const leaver = live().find((b) => !fixed.has(b) && b !== occupant);
            if (leaver === undefined) return;
            leaver.ws.close();
            if (sample !== null) {
              sample.waiting.delete(leaver);
              if (sample.waiting.size === 0) settle(leaver);
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
            for (const t of timers) {
              clearTimeout(t);
              clearInterval(t);
            }
            for (const b of bots) b.ws.close();
            return stats();
          },
        },
      });
    },
    { url: socketUrl(roomId), o: opts },
  );
  const call = (fn: "stats" | "stop") =>
    page.evaluate((f) => {
      const t: unknown = Reflect.get(window, "omegaTraffic");
      const g: unknown = typeof t === "object" && t !== null ? Reflect.get(t, f) : null;
      if (typeof g !== "function") throw new Error("traffic not running");
      return (g as () => TrafficStats)();
    }, fn);
  return {
    stats: () => call("stats"),
    stop: async () => {
      const s = await call("stop");
      await context.close();
      return s;
    },
  };
}
