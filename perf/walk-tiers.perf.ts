// OME-731 (M8 W2, ADR 0037): the frame budgets with 25 members walking, on each forced walk tier (Basic: one render per
// 150 ms whole-step; Smooth: a render every frame while anyone walks), on desktop Chromium and on a Pixel 7 phone
// (devices["Pixel 7"], the phone watch layout). One site client (the observer, tier forced with
// localStorage["omega.motion"]) + 24 raw-socket bots that keep sitting on free seats and standing up again, one change
// roughly every 120 ms, so most of the 24 are walking at any moment (8 seats, so the rest stand about). The video plays
// (fake player). Rows: walk25.frameP95.<profile>.<tier> (quantised p95 ≤ one vsync), walk25.workP95.<profile>.<tier>
// (≤ 8 ms), walk25.missedVsync.<profile>.<tier> (≤ 1 %), for profile = desktop | phone, tier = basic | smooth.
import { devices, expect, test } from "@playwright/test";
import type { Browser, BrowserContextOptions, Page } from "@playwright/test";
import { MAX_ROOM_MEMBERS } from "@omega/shared";
import { PENDING, URLS, available } from "../e2e/support/apps";
import { socketUrl } from "../e2e/support/bots";
import { watchCsp } from "../e2e/support/csp";
import { joinRoom, leaveAll, testRoom } from "../e2e/support/room";
import { site } from "../e2e/support/selectors";
import { VSYNC_MS, tracedFrames } from "./frames";
import { p95, recordMetric } from "./metrics";
import { summarizeFrames } from "./spread";
import { shareVideo, waitPlaying } from "./sync";

const WINDOW_MS = 5000;
const BOTS = MAX_ROOM_MEMBERS - 1;
const CHANGE_EVERY_MS = 120;
const MIN_WALKERS = 15;
const PROFILES = ["desktop", "phone"] as const;
const TIERS = ["basic", "smooth"] as const;
type Profile = (typeof PROFILES)[number];
type Tier = (typeof TIERS)[number];
const BOT_PREFIX = "w25-bot";

const ids = (p: Profile, t: Tier): string[] => [`walk25.frameP95.${p}.${t}`, `walk25.workP95.${p}.${t}`, `walk25.missedVsync.${p}.${t}`];

interface WalkerStats {
  readonly members: number;
  readonly changes: number;
  readonly errors: readonly string[];
}

/** 24 raw-socket bots on a page of the site origin, sitting on free seats and standing up again, one change per tick. */
async function startWalkers(browser: Browser, roomId: string): Promise<{ stats: () => Promise<WalkerStats>; stop: () => Promise<WalkerStats> }> {
  const context = await watchCsp(await browser.newContext());
  const page = await context.newPage();
  await page.goto(URLS.web);
  await page.evaluate(
    async ({ url, bots, prefix, everyMs }) => {
      interface Bot { ws: WebSocket; self: string }
      const all: Bot[] = [];
      /** seats[i] is the member id holding seat i, from the server's snapshot / seat-changed / member-left stream. */
      let seats: (string | null)[] = [];
      let changes = 0;
      let members = 0;
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
            } else if (n === 0 && msg.type === "seat-changed" && "seat" in msg) {
              changes++;
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
      }, everyMs);
      const stats = () => ({ members, changes, errors: [...errors] });
      Object.assign(window, {
        omegaWalkers: {
          stats,
          stop: () => {
            clearInterval(timer);
            for (const b of all) b.ws.close();
            return stats();
          },
        },
      });
    },
    { url: socketUrl(roomId), bots: BOTS, prefix: BOT_PREFIX, everyMs: CHANGE_EVERY_MS },
  );
  const call = async (fn: "stats" | "stop"): Promise<WalkerStats> => {
    const raw: unknown = await page.evaluate((f): unknown => {
      const t: unknown = Reflect.get(window, "omegaWalkers");
      const g: unknown = typeof t === "object" && t !== null ? Reflect.get(t, f) : null;
      if (typeof g !== "function") throw new Error("walkers not running");
      return Reflect.apply(g, t, []);
    }, fn);
    if (typeof raw !== "object" || raw === null) throw new Error("walkers: bad stats");
    const members: unknown = Reflect.get(raw, "members");
    const changes: unknown = Reflect.get(raw, "changes");
    const errors: unknown = Reflect.get(raw, "errors");
    if (typeof members !== "number" || typeof changes !== "number" || !Array.isArray(errors)) throw new Error("walkers: bad stats");
    return { members, changes, errors: errors.map(String) };
  };
  return {
    stats: () => call("stats"),
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
        const w = await tracedFrames(browser, page, WINDOW_MS);
        const end = await botTags(page);
        const walking = Object.keys(start).filter((n) => start[n] !== end[n]).length;
        const s = await walkers.stats();
        const f = summarizeFrames(w.samples, VSYNC_MS);
        const workP95 = p95(w.workMs);
        const what = `${profile === "phone" ? "Pixel 7 emulation" : "desktop Chromium"}, forced ${tier} tier, ${String(walking)} of ${String(Object.keys(start).length)} bot tags moved in the window, ${String(s.members)} members, ${String(s.changes)} seat changes so far, video playing (fake player)`;
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
