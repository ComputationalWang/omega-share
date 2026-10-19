// OME-731 (M8 W2, ADR 0037): the frame budgets with 25 members walking, on each forced walk tier (Basic: one render per
// 150 ms whole-step; Smooth: a render every frame while anyone walks), on desktop Chromium and on a Pixel 7 phone
// (devices["Pixel 7"], the phone watch layout). One site client (the observer, tier forced with
// localStorage["omega.motion"]) + 24 raw-socket bots that keep sitting on free seats and standing up again, one change
// roughly every 120 ms, and (OME-1353, ADR 0053) free-walking standing bots to random free cells, two walks a tick,
// so most of the 24 are walking at any moment (8 seats, so the rest walk about). The video plays
// (fake player). Rows: walk25.frameP95.<profile>.<tier> (quantised p95 ≤ one vsync), walk25.workP95.<profile>.<tier>
// (≤ 8 ms), walk25.missedVsync.<profile>.<tier> (≤ 1 %), for profile = desktop | phone, tier = basic | smooth.
// OMEGA_PERF_WALK_LAYOUT=<preset id> (OME-1439): the observer sees that preset instead (its snapshots rewritten). With bar the bots in
// the hammock seats (4–7) sway them, a bot at the piano's front plays it and the playing video lights the fireplace: the
// same rows with every batch 6 loop running. Bots still walk the default layout's free cells (the server's layout).
import { devices, expect, test } from "@playwright/test";
import type { Browser, BrowserContextOptions, Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { DEFAULT_LAYOUT, FLOOR_CELLS, MAX_ROOM_MEMBERS, isStandable } from "@omega/shared";
import { PENDING, URLS, available } from "../e2e/support/apps";
import { socketUrl } from "../e2e/support/bots";
import { watchCsp } from "../e2e/support/csp";
import { joinRoom, leaveAll, testRoom } from "../e2e/support/room";
import { site } from "../e2e/support/selectors";
import { VSYNC_MS, tracedFrames } from "./frames";
import { p95, recordMetric } from "./metrics";
import { summarizeFrames } from "./spread";
import { shareVideo, waitPlaying } from "./sync";
import { walkedInWindow } from "./walkers";

const WINDOW_MS = 5000;
const BOTS = MAX_ROOM_MEMBERS - 1;
const CHANGE_EVERY_MS = 120;
const MIN_WALKERS = 15;
/** Free walks per tick (ADR 0053): ~17/s room-wide, each bot well under its 4/s walk bucket. */
const WALKS_PER_TICK = 2;
/** Every cell a bot may walk to in the default layout (the seeded room has no layout of its own). */
const FREE_CELLS = Array.from({ length: FLOOR_CELLS * FLOOR_CELLS }, (_, i) => ({ x: i % FLOOR_CELLS, y: Math.floor(i / FLOOR_CELLS) })).filter((c) =>
  isStandable(DEFAULT_LAYOUT, c),
);
const PROFILES = ["desktop", "phone"] as const;
const TIERS = ["basic", "smooth"] as const;
type Profile = (typeof PROFILES)[number];
type Tier = (typeof TIERS)[number];
const BOT_PREFIX = "w25-bot";
const LAYOUT_PRESET = process.env["OMEGA_PERF_WALK_LAYOUT"] ?? "";
if (LAYOUT_PRESET !== "" && !/^[a-z]{1,12}$/.test(LAYOUT_PRESET)) throw new Error(`OMEGA_PERF_WALK_LAYOUT must be a preset id, not ${JSON.stringify(LAYOUT_PRESET)}`);
const BAR_LAYOUT: unknown = LAYOUT_PRESET === "" ? null : JSON.parse(readFileSync(new URL(`../assets/presets/${LAYOUT_PRESET}.json`, import.meta.url), "utf8"));

const ids = (p: Profile, t: Tier): string[] => [`walk25.frameP95.${p}.${t}`, `walk25.workP95.${p}.${t}`, `walk25.missedVsync.${p}.${t}`];

interface WalkerStats {
  readonly members: number;
  readonly changes: number;
  /** `walked` relays seen so far (free walks to a cell). */
  readonly walks: number;
  readonly errors: readonly string[];
  /** Bot nicknames with a seat change since the last `mark()` (sat or stood up: they walked). */
  readonly seatChanged: readonly string[];
}

/** 24 raw-socket bots on a page of the site origin, sitting on free seats and standing up again, one change per tick, and free-walking standing bots. */
async function startWalkers(browser: Browser, roomId: string): Promise<{ stats: () => Promise<WalkerStats>; mark: () => Promise<WalkerStats>; stop: () => Promise<WalkerStats> }> {
  const context = await watchCsp(await browser.newContext());
  const page = await context.newPage();
  await page.goto(URLS.web);
  await page.evaluate(
    async ({ url, bots, prefix, everyMs, cells, walksPerTick }) => {
      interface Bot { ws: WebSocket; self: string }
      const all: Bot[] = [];
      /** seats[i] is the member id holding seat i, from the server's snapshot / seat-changed / member-left stream. */
      let seats: (string | null)[] = [];
      let changes = 0;
      let walks = 0;
      let members = 0;
      /** Bot nickname by member id, and the bots whose seat changed since the last mark(). */
      const names = new Map<string, string>();
      let changedSinceMark = new Set<string>();
      const errors: string[] = [];
      const join = (n: number): Promise<Bot> =>
        new Promise((resolve, reject) => {
          const ws = new WebSocket(url);
          const bot: Bot = { ws, self: "" };
          ws.addEventListener("open", () => {
            ws.send(JSON.stringify({ type: "join", nickname: `${prefix}-${String(n + 1)}`, avatar: n % 4 }));
          });
          ws.addEventListener("message", (ev: MessageEvent<unknown>) => {
            const msg: unknown = typeof ev.data === "string" ? JSON.parse(ev.data) : null;
            if (typeof msg !== "object" || msg === null || !("type" in msg)) return;
            const memberId = "memberId" in msg && typeof msg.memberId === "string" ? msg.memberId : null;
            if (msg.type === "snapshot" && "self" in msg && typeof msg.self === "string" && "room" in msg) {
              bot.self = msg.self;
              names.set(msg.self, `${prefix}-${String(n + 1)}`);
              const room = msg.room;
              if (n === 0 && typeof room === "object" && room !== null) {
                if ("members" in room && Array.isArray(room.members)) members = room.members.length;
                if ("seats" in room && Array.isArray(room.seats)) seats = room.seats.map((s: unknown) => (typeof s === "string" ? s : null));
              }
              resolve(bot);
            } else if (msg.type === "room-full") reject(new Error("room-full"));
            else if (msg.type === "error" && "code" in msg) errors.push(String(msg.code));
            else if (n === 0 && msg.type === "member-joined") members++;
            else if (n === 0 && msg.type === "member-left") {
              members--;
              seats = seats.map((s) => (s === memberId ? null : s));
            } else if (n === 0 && msg.type === "walked") {
              walks++;
              const who = memberId === null ? undefined : names.get(memberId);
              if (who !== undefined) changedSinceMark.add(who);
            } else if (n === 0 && msg.type === "seat-changed" && "seat" in msg) {
              changes++;
              const who = memberId === null ? undefined : names.get(memberId);
              if (who !== undefined) changedSinceMark.add(who);
              seats = seats.map((s) => (s === memberId ? null : s));
              if (typeof msg.seat === "number") seats[msg.seat] = memberId;
            }
          });
          ws.addEventListener("close", () => {
            if (bot.self === "") reject(new Error("closed before snapshot"));
          });
          all.push(bot);
        });
      for (let i = 0; i < bots; i++) await join(i);
      const timer = window.setInterval(() => {
        const free = seats.flatMap((s, i) => (s === null ? [i] : []));
        const seated = all.filter((b) => seats.includes(b.self));
        const standing = all.filter((b) => !seats.includes(b.self));
        // Keep 2-6 of the 8 seats full: a sit or a stand, at random in between.
        const sit = seated.length < 2 || (seated.length < 6 && Math.random() < 0.5);
        if (sit) {
          const bot = standing[Math.floor(Math.random() * standing.length)];
          const seat = free[Math.floor(Math.random() * free.length)];
          if (bot !== undefined && seat !== undefined) bot.ws.send(JSON.stringify({ type: "sit", seat }));
        } else {
          const bot = seated[Math.floor(Math.random() * seated.length)];
          bot?.ws.send(JSON.stringify({ type: "sit", seat: null }));
        }
        for (let k = 0; k < walksPerTick; k++) {
          const bot = standing[Math.floor(Math.random() * standing.length)];
          const cell = cells[Math.floor(Math.random() * cells.length)];
          if (bot !== undefined && cell !== undefined) bot.ws.send(JSON.stringify({ type: "walk", cell }));
        }
      }, everyMs);
      const stats = () => ({ members, changes, walks, errors: [...errors], seatChanged: [...changedSinceMark] });
      Object.assign(window, {
        omegaWalkers: {
          stats,
          mark: () => {
            const s = stats();
            changedSinceMark = new Set();
            return s;
          },
          stop: () => {
            clearInterval(timer);
            for (const b of all) b.ws.close();
            return stats();
          },
        },
      });
    },
    { url: socketUrl(roomId), bots: BOTS, prefix: BOT_PREFIX, everyMs: CHANGE_EVERY_MS, cells: FREE_CELLS, walksPerTick: WALKS_PER_TICK },
  );
  const call = async (fn: "stats" | "mark" | "stop"): Promise<WalkerStats> => {
    const raw: unknown = await page.evaluate((f): unknown => {
      const t: unknown = Reflect.get(window, "omegaWalkers");
      const g: unknown = typeof t === "object" && t !== null ? Reflect.get(t, f) : null;
      if (typeof g !== "function") throw new Error("walkers not running");
      return Reflect.apply(g, t, []);
    }, fn);
    if (typeof raw !== "object" || raw === null) throw new Error("walkers: bad stats");
    const members: unknown = Reflect.get(raw, "members");
    const changes: unknown = Reflect.get(raw, "changes");
    const walks: unknown = Reflect.get(raw, "walks");
    const errors: unknown = Reflect.get(raw, "errors");
    const seatChanged: unknown = Reflect.get(raw, "seatChanged");
    if (typeof members !== "number" || typeof changes !== "number" || typeof walks !== "number" || !Array.isArray(errors) || !Array.isArray(seatChanged)) throw new Error("walkers: bad stats");
    return { members, changes, walks, errors: errors.map(String), seatChanged: seatChanged.map(String) };
  };
  return {
    stats: () => call("stats"),
    mark: () => call("mark"),
    stop: async () => {
      const s = await call("stop");
      await context.close();
      return s;
    },
  };
}

/** Every bot nickname tag's transform on `page`, by nickname. */
const botTags = (page: Page): Promise<Record<string, string>> =>
  page.evaluate(
    (prefix) =>
      Object.fromEntries(
        [...document.querySelectorAll("[data-testid='nickname-tag']")]
          .filter((t) => t.textContent.startsWith(prefix))
          .map((t) => [t.textContent, (t as HTMLElement).style.transform]),
      ),
    BOT_PREFIX,
  );

for (const profile of PROFILES) {
  test(`walk tiers: 25 members walking, ${profile}, Basic then Smooth (video playing)`, async ({ browser, request }) => {
    const why = !available.web ? PENDING.web : !available.server ? PENDING.server : null;
    if (why !== null) {
      for (const t of TIERS) for (const id of ids(profile, t)) recordMetric({ id, pending: why });
      test.skip(true, why);
      return;
    }
    test.setTimeout(240_000);
    // The same seeded room as the pop-out room perf (specs run one after the other on one worker, each leaving it empty).
    const room = testRoom("popout-room-perf", "frames");
    await expect
      .poll(
        async () => {
          try {
            await shareVideo(request, room.id);
            return true;
          } catch {
            return false;
          }
        },
        { timeout: 60_000, intervals: [2_000, 5_000, 10_000] },
      )
      .toBe(true);
    const phone: BrowserContextOptions | undefined = profile === "phone" ? { ...devices["Pixel 7"] } : undefined;
    const results: { tier: Tier; p95: number; missedPct: number; workP95: number; walking: number }[] = [];
    for (const tier of TIERS) {
      const clients = await joinRoom(browser, {
        roomUrl: room.url,
        count: 1,
        nicknamePrefix: `w25-${profile}`,
        contextOptions: () => phone,
        setup: async (context) => {
          await context.addInitScript((t) => {
            localStorage.setItem("omega.motion", t);
          }, tier);
          if (BAR_LAYOUT !== null) {
            await context.routeWebSocket(/\/rooms\/[^/]+\/ws$/, (ws) => {
              const server = ws.connectToServer();
              server.onMessage((m) => {
                const msg: unknown = typeof m === "string" ? JSON.parse(m) : null;
                const room: unknown = typeof msg === "object" && msg !== null && Reflect.get(msg, "type") === "snapshot" ? Reflect.get(msg, "room") : null;
                if (typeof room === "object" && room !== null) Reflect.set(room, "layout", BAR_LAYOUT);
                ws.send(room === null ? m : JSON.stringify(msg));
              });
            });
          }
        },
      });
      const walkers = await startWalkers(browser, room.id);
      try {
        const [observer] = clients;
        if (observer === undefined) throw new Error("no observer");
        const page = observer.page;
        await waitPlaying(clients);
        // The row ran on the tier it claims.
        await expect(page.locator("canvas.scene")).toHaveAttribute("data-motion", tier);
        await expect(page.locator(site.nicknameTag)).toHaveCount(MAX_ROOM_MEMBERS);
        if (profile === "phone") {
          // The room window on screen, so it is painted.
          await page.locator(site.roomWindow).evaluate((el) => {
            el.scrollIntoView({ block: "start" });
          });
          await expect(page.locator(site.roomWindow)).toBeInViewport();
        }
        // The walks in from the door are over and the seats are churning.
        await page.waitForTimeout(3000);
        const start = await botTags(page);
        await walkers.mark();
        const w = await tracedFrames(browser, page, WINDOW_MS);
        const end = await botTags(page);
        const s = await walkers.stats();
        const loops: unknown =
          BAR_LAYOUT === null
            ? null
            : await page.evaluate(() => {
                const room: unknown = Reflect.get(Reflect.get(window, "__omega") ?? {}, "room");
                const fn: unknown = typeof room === "object" && room !== null ? Reflect.get(room, "furnitureLoops") : null;
                return typeof fn === "function" ? (Reflect.apply(fn, room, []) as unknown) : null;
              });
        // Walked in the window: moved, or changed seat (a round trip to a stable slot ends where it began, ADR 0043).
        const walking = walkedInWindow(start, end, s.seatChanged);
        const f = summarizeFrames(w.samples, VSYNC_MS);
        const workP95 = p95(w.workMs);
        const what = `${profile === "phone" ? "Pixel 7 emulation" : "desktop Chromium"}, forced ${tier} tier, ${String(walking)} of ${String(Object.keys(start).length)} bot tags walked in the window (moved or changed seat), ${String(s.members)} members, ${String(s.changes)} seat changes and ${String(s.walks)} free walks so far, ${String(s.errors.length)} errors, video playing (fake player)${loops === null ? "" : `, ${LAYOUT_PRESET} layout, loops at the end ${JSON.stringify(loops)}`}`;
        recordMetric({ id: `walk25.frameP95.${profile}.${tier}`, value: f.p95, note: `${f.note}; ${what}` });
        recordMetric({ id: `walk25.workP95.${profile}.${tier}`, value: workP95, note: `${String(w.workMs.length)} traced frames, max ${Math.max(...w.workMs).toFixed(2)} ms; ${what}` });
        recordMetric({ id: `walk25.missedVsync.${profile}.${tier}`, value: f.missedPct, note: `${String(f.missed)} of ${String(f.frames)} frames; ${what}` });
        expect(s.members).toBe(MAX_ROOM_MEMBERS);
        expect(walking, `the window measures walking: ${what}`).toBeGreaterThanOrEqual(MIN_WALKERS);
        results.push({ tier, p95: f.p95, missedPct: f.missedPct, workP95, walking });
      } finally {
        await walkers.stop();
        await leaveAll(clients);
      }
    }
    for (const r of results) {
      const k = `${profile}.${r.tier}`;
      expect(r.p95, `${k} frame p95`).toBeLessThanOrEqual(VSYNC_MS + 1e-6);
      expect(r.missedPct, `${k} missed vsyncs %`).toBeLessThanOrEqual(1);
      expect(r.workP95, `${k} main-thread work p95`).toBeLessThanOrEqual(8);
    }
  });
}
