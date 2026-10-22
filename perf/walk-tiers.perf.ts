// OME-731 (M8 W2, ADR 0037): the frame budgets with 25 members walking, on each forced walk tier (Basic: one render per
// 150 ms whole-step; Smooth: a render every frame while anyone walks), on desktop Chromium and on a Pixel 7 phone
// (devices["Pixel 7"], the phone watch layout). One site client (the observer, tier forced with
// localStorage["omega.motion"]) + 24 raw-socket bots that keep sitting on free seats and standing up again, one change
// roughly every 120 ms, and (OME-1353, ADR 0053) free-walking standing bots to random free cells, two walks a tick,
// so most of the 24 are walking at any moment (8 seats, so the rest walk about). The video plays
// (fake player). Rows: walk25.frameP95.<profile>.<tier> (quantised p95 ≤ one vsync), walk25.workP95.<profile>.<tier>
// (≤ 8 ms), walk25.missedVsync.<profile>.<tier> (≤ 1 %), for profile = desktop | phone, tier = basic | smooth.
// The observer sees the cafe preset (OME-1448, docs/perf-budgets.md): the shipped preset with the most object pieces, so
// the rows hold the dearest furnished room, not only the default layout's. OMEGA_PERF_WALK_LAYOUT=<preset id> (OME-1439)
// shows another preset, `default` the default layout. The room's own layout stays the default one (its snapshots are
// rewritten in the observer's page), so bots walk the cells free in both. With bar the bots in the hammock seats (4–7)
// sway them, a bot at the piano's front plays it and the playing video lights the fireplace: every batch 6 loop runs.
// Then Smooth again with every member wearing an accessory (OME-1542): bot n wears 1 + n % 8, the observer the halo, so
// the walk25.accessories.<metric>.<profile> rows hold the overlay on all 25.
// Then Smooth again with a 12-person /conga line (OME-1578): bots 1–12 send `/conga`, then every 360 ms the leader walks
// to a random cell and each of the others, as Follow does, walks to where the one ahead was once that one's `walked`
// comes back: one relay round trip per link, not all 12 in one tick. The other 12 keep churning seats and free-walking.
// walk25.conga.<metric>.<profile>.
// Then, on the phone only, Smooth again with a reaction burst (OME-1643, Movie night): 7 bots each send EMOTE_BURST
// `react`s, then one a refill, so the observer gets ~7 `reacted` relays a second on top of the walks; ≤ 1 % of them may go
// unrelayed. walk25.react.<metric>.phone. PENDING while the server relays no `reacted` (OME-1632).
// OMEGA_PERF_WALK_RUN=1 (OME-1464): the bots jog (`walk.run`) instead, for the same rows with 25 joggers.
import { devices, expect, test } from "@playwright/test";
import type { Browser, BrowserContextOptions, Page } from "@playwright/test";
import { ACCESSORY_COUNT, CONGA_CAP, EMOTE_BURST, EMOTE_REFILL_MS, DEFAULT_LAYOUT, FLOOR_CELLS, MAX_ROOM_MEMBERS, isStandable } from "@omega/shared";
import { PENDING, URLS, available } from "../e2e/support/apps";
import { socketUrl } from "../e2e/support/bots";
import { watchCsp } from "../e2e/support/csp";
import { joinRoom, leaveAll, testRoom } from "../e2e/support/room";
import { site } from "../e2e/support/selectors";
import { VSYNC_MS, tracedFrames } from "./frames";
import { p95, recordMetric } from "./metrics";
import { presetFile, showLayout } from "./show-layout";
import { summarizeFrames } from "./spread";
import { shareVideo, waitPlaying } from "./sync";
import { walkedInWindow } from "./walkers";

const WINDOW_MS = 5000;
const BOTS = MAX_ROOM_MEMBERS - 1;
const CHANGE_EVERY_MS = 120;
const MIN_WALKERS = 15;
/** Free walks per tick (ADR 0053): ~17/s room-wide, each bot well under its 4/s walk bucket. */
const WALKS_PER_TICK = 2;
const PROFILES = ["desktop", "phone"] as const;
const TIERS = ["basic", "smooth"] as const;
type Profile = (typeof PROFILES)[number];
type Tier = (typeof TIERS)[number];
interface Pass { readonly tier: Tier; readonly worn: boolean; readonly conga: boolean; readonly react: boolean }
/** Each tier bare, then Smooth with everyone wearing an accessory, then Smooth with a /conga line, then (phone only) Smooth with a reaction burst. */
const PASSES: readonly Pass[] = [
  ...TIERS.map((tier) => ({ tier, worn: false, conga: false, react: false })),
  { tier: "smooth", worn: true, conga: false, react: false },
  { tier: "smooth", worn: false, conga: true, react: false },
  { tier: "smooth", worn: false, conga: false, react: true },
];
const passesFor = (p: Profile): readonly Pass[] => PASSES.filter((pass) => !pass.react || p === "phone");
/** OME-1643: bots reacting in the reaction-burst pass, each at the emote bucket's rate (EMOTE_BURST, then one per EMOTE_REFILL_MS). */
const REACTERS = 7;
/** Just over the refill, so timer and socket jitter never land a react on an empty bucket (dropped silently). */
const REACT_EVERY_MS = EMOTE_REFILL_MS + 20;
/** Bots in the /conga pass's line (the cap, CONGA_CAP), and its leader's walk period in walker ticks. */
const CONGA_LINE = CONGA_CAP;
const CONGA_EVERY_TICKS = 3;
const BOT_PREFIX = "w25-bot";
const LAYOUT_PRESET = process.env["OMEGA_PERF_WALK_LAYOUT"] ?? "cafe";
const RUN = process.env["OMEGA_PERF_WALK_RUN"] === "1";
const SHOWN_LAYOUT = LAYOUT_PRESET === "default" ? null : presetFile(LAYOUT_PRESET);
/** Every cell a bot may walk to: free in the room's own (default) layout, which the server checks, and in the one shown. */
const FREE_CELLS = Array.from({ length: FLOOR_CELLS * FLOOR_CELLS }, (_, i) => ({ x: i % FLOOR_CELLS, y: Math.floor(i / FLOOR_CELLS) })).filter(
  (c) => isStandable(DEFAULT_LAYOUT, c) && (SHOWN_LAYOUT === null || isStandable(SHOWN_LAYOUT, c)),
);

const rowId = (m: string, p: Profile, pass: Pass): string => (pass.react ? `walk25.react.${m}.${p}` : pass.worn ? `walk25.accessories.${m}.${p}` : pass.conga ? `walk25.conga.${m}.${p}` : `walk25.${m}.${p}.${pass.tier}`);
const ids = (p: Profile, pass: Pass): string[] => ["frameP95", "workP95", "missedVsync"].map((m) => rowId(m, p, pass));

interface WalkerStats {
  readonly members: number;
  readonly changes: number;
  /** `walked` relays seen so far (free walks to a cell). */
  readonly walks: number;
  /** Reaction-burst pass: `react`s sent, and `reacted` relays seen by bot 1. */
  readonly reactsSent: number;
  readonly reacted: number;
  readonly errors: readonly string[];
  /** Bot nicknames with a seat change since the last `mark()` (sat or stood up: they walked). */
  readonly seatChanged: readonly string[];
}

/** 24 raw-socket bots on a page of the site origin, sitting on free seats and standing up again, one change per tick, and free-walking standing bots. */
async function startWalkers(browser: Browser, roomId: string, worn: boolean, conga: number, reacters: number): Promise<{ stats: () => Promise<WalkerStats>; mark: () => Promise<WalkerStats>; stop: () => Promise<WalkerStats> }> {
  const context = await watchCsp(await browser.newContext());
  const page = await context.newPage();
  await page.goto(URLS.web);
  await page.evaluate(
    async ({ url, bots, prefix, everyMs, cells, walksPerTick, run, accessories, conga, congaEvery, reacters, emoteBurst, reactEvery }) => {
      interface Bot { ws: WebSocket; self: string }
      const all: Bot[] = [];
      /** seats[i] is the member id holding seat i, from the server's snapshot / seat-changed / member-left stream. */
      let seats: (string | null)[] = [];
      let changes = 0;
      let walks = 0;
      let reactsSent = 0;
      let reacted = 0;
      let members = 0;
      /** Bot nickname by member id, and the bots whose seat changed since the last mark(). */
      const names = new Map<string, string>();
      let changedSinceMark = new Set<string>();
      const errors: string[] = [];
      /** The /conga line: its bots, their place in it by member id, and the cell each was last relayed at. */
      let line: Bot[] = [];
      const lineIndex = new Map<string, number>();
      const lastCell: ({ x: number; y: number } | undefined)[] = [];
      const join = (n: number): Promise<Bot> =>
        new Promise((resolve, reject) => {
          const ws = new WebSocket(url);
          const bot: Bot = { ws, self: "" };
          ws.addEventListener("open", () => {
            ws.send(JSON.stringify({ type: "join", nickname: `${prefix}-${String(n + 1)}`, avatar: n % 4, ...(accessories > 0 ? { accessory: 1 + (n % (accessories - 1)) } : {}) }));
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
            } else if (n === 0 && msg.type === "reacted") reacted++;
            else if (n === 0 && msg.type === "walked") {
              walks++;
              // Follow: the next in line walks to where this one was, once this one's walk is relayed.
              const i = memberId === null ? -1 : lineIndex.get(memberId) ?? -1;
              const cell = "cell" in msg ? msg.cell : null;
              if (i >= 0 && typeof cell === "object" && cell !== null && "x" in cell && "y" in cell && typeof cell.x === "number" && typeof cell.y === "number") {
                const behind = lastCell[i];
                lastCell[i] = { x: cell.x, y: cell.y };
                if (behind !== undefined) line[i + 1]?.ws.send(JSON.stringify({ type: "walk", cell: behind }));
              }
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
      // The /conga line (OME-1578): spaced past the chat bucket's refill, so every `/conga` is relayed.
      line = all.slice(0, conga);
      line.forEach((b, i) => {
        lineIndex.set(b.self, i);
        lastCell[i] = cells[i];
      });
      for (const b of line) {
        b.ws.send(JSON.stringify({ type: "chat", text: "/conga" }));
        await new Promise((r) => setTimeout(r, 100));
      }
      // The reaction burst (OME-1643): each reacter empties its bucket, then reacts once a refill.
      const kinds = ["heart", "laugh", "wow", "clap"];
      const react = (b: Bot): void => {
        b.ws.send(JSON.stringify({ type: "react", kind: kinds[reactsSent % kinds.length] }));
        reactsSent++;
      };
      const reacting = all.slice(line.length, line.length + reacters);
      for (const b of reacting) for (let i = 0; i < emoteBurst; i++) react(b);
      const reactTimer = reacting.length === 0 ? 0 : window.setInterval(() => {
        for (const b of reacting) react(b);
      }, reactEvery);
      let tick = 0;
      const timer = window.setInterval(() => {
        tick++;
        const lead = cells[Math.floor(Math.random() * cells.length)];
        if (lead !== undefined && tick % congaEvery === 0) line[0]?.ws.send(JSON.stringify({ type: "walk", cell: lead }));
        const free = seats.flatMap((s, i) => (s === null ? [i] : []));
        const seated = all.filter((b) => !line.includes(b) && seats.includes(b.self));
        const standing = all.filter((b) => !line.includes(b) && !seats.includes(b.self));
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
          if (bot !== undefined && cell !== undefined) bot.ws.send(JSON.stringify(run ? { type: "walk", cell, run } : { type: "walk", cell }));
        }
      }, everyMs);
      const stats = () => ({ members, changes, walks, reactsSent, reacted, errors: [...errors], seatChanged: [...changedSinceMark] });
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
            clearInterval(reactTimer);
            for (const b of all) b.ws.close();
            return stats();
          },
        },
      });
    },
    { url: socketUrl(roomId), bots: BOTS, prefix: BOT_PREFIX, everyMs: CHANGE_EVERY_MS, cells: FREE_CELLS, walksPerTick: WALKS_PER_TICK, run: RUN, accessories: worn ? ACCESSORY_COUNT : 0, conga, congaEvery: CONGA_EVERY_TICKS, reacters, emoteBurst: EMOTE_BURST, reactEvery: REACT_EVERY_MS },
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
    const reactsSent: unknown = Reflect.get(raw, "reactsSent");
    const reacted: unknown = Reflect.get(raw, "reacted");
    const errors: unknown = Reflect.get(raw, "errors");
    const seatChanged: unknown = Reflect.get(raw, "seatChanged");
    if (typeof members !== "number" || typeof changes !== "number" || typeof walks !== "number" || typeof reactsSent !== "number" || typeof reacted !== "number" || !Array.isArray(errors) || !Array.isArray(seatChanged)) throw new Error("walkers: bad stats");
    return { members, changes, walks, reactsSent, reacted, errors: errors.map(String), seatChanged: seatChanged.map(String) };
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
  test(`walk tiers: 25 members walking, ${profile}, Basic, Smooth, Smooth with accessories, Smooth with a /conga line (video playing)`, async ({ browser, request }) => {
    const why = !available.web ? PENDING.web : !available.server ? PENDING.server : null;
    if (why !== null) {
      for (const pass of passesFor(profile)) for (const id of ids(profile, pass)) recordMetric({ id, pending: why });
      test.skip(true, why);
      return;
    }
    test.setTimeout(480_000);
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
    const results: { row: string; p95: number; missedPct: number; workP95: number; walking: number }[] = [];
    for (const pass of passesFor(profile)) {
      const { tier, worn, conga, react } = pass;
      const clients = await joinRoom(browser, {
        roomUrl: room.url,
        count: 1,
        nicknamePrefix: `w25-${profile}`,
        contextOptions: () => phone,
        setup: async (context) => {
          await context.addInitScript(
            ({ t, accessory }) => {
              localStorage.setItem("omega.motion", t);
              if (accessory > 0) localStorage.setItem("omega.accessory", String(accessory));
            },
            { t: tier, accessory: worn ? ACCESSORY_COUNT - 1 : 0 },
          );
          if (SHOWN_LAYOUT !== null) await showLayout(context, SHOWN_LAYOUT);
        },
      });
      const walkers = await startWalkers(browser, room.id, worn, conga ? CONGA_LINE : 0, react ? REACTERS : 0);
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
        // Reactions still in flight at the window's end get 500 ms to come back before they count as missed.
        const reacted = react ? (await page.waitForTimeout(500), (await walkers.stats()).reacted) : 0;
        const missedReacts = s.reactsSent === 0 ? 0 : (100 * Math.max(0, s.reactsSent - reacted)) / s.reactsSent;
        const loops: unknown =
          SHOWN_LAYOUT === null
            ? null
            : await page.evaluate(() => {
                const room: unknown = Reflect.get(Reflect.get(window, "__omega") ?? {}, "room");
                const fn: unknown = typeof room === "object" && room !== null ? Reflect.get(room, "furnitureLoops") : null;
                return typeof fn === "function" ? (Reflect.apply(fn, room, []) as unknown) : null;
              });
        // Walked in the window: moved, or changed seat (a round trip to a stable slot ends where it began, ADR 0043).
        const walking = walkedInWindow(start, end, s.seatChanged);
        const congaLines = await page.locator(site.chatLogLine).filter({ hasText: "/conga" }).count();
        const f = summarizeFrames(w.samples, VSYNC_MS);
        const workP95 = p95(w.workMs);
        const what = `${profile === "phone" ? "Pixel 7 emulation" : "desktop Chromium"}, forced ${tier} tier${worn ? ", every member wearing an accessory" : ""}, ${String(walking)} of ${String(Object.keys(start).length)} bot tags walked in the window (moved or changed seat), ${String(s.members)} members, ${String(s.changes)} seat changes and ${String(s.walks)} free ${RUN ? "jogs" : "walks"} so far, ${String(s.errors.length)} errors, video playing (fake player), ${LAYOUT_PRESET} layout${conga ? `, ${String(congaLines)}-person /conga line` : ""}${react ? `, ${String(REACTERS)} members reacting at the rate limit: ${String(reacted)} of ${String(s.reactsSent)} reactions relayed (${missedReacts.toFixed(1)} % missed)` : ""}${loops === null ? "" : `, loops at the end ${JSON.stringify(loops)}`}`;
        if (react && reacted === 0) {
          // shortcut: until OME-1632 the server takes `react` but relays nothing, so the burst costs the observer nothing; drop this branch once it lands.
          for (const id of ids(profile, pass)) recordMetric({ id, pending: `the server relayed no \`reacted\` (OME-1632 not merged); ${what}` });
          continue;
        }
        expect(missedReacts, `≤ 1 % of the reactions go unrelayed: ${what}`).toBeLessThanOrEqual(1);
        recordMetric({ id: rowId("frameP95", profile, pass), value: f.p95, note: `${f.note}; ${what}` });
        recordMetric({ id: rowId("workP95", profile, pass), value: workP95, note: `${String(w.workMs.length)} traced frames, max ${Math.max(...w.workMs).toFixed(2)} ms; ${what}` });
        recordMetric({ id: rowId("missedVsync", profile, pass), value: f.missedPct, note: `${String(f.missed)} of ${String(f.frames)} frames; ${what}` });
        expect(s.members).toBe(MAX_ROOM_MEMBERS);
        expect(congaLines, `the observer saw the whole /conga line: ${what}`).toBe(conga ? CONGA_LINE : 0);
        expect(walking, `the window measures walking: ${what}`).toBeGreaterThanOrEqual(MIN_WALKERS);
        results.push({ row: `${profile}.${tier}${worn ? " with accessories" : ""}${conga ? " with a /conga line" : ""}${react ? " with a reaction burst" : ""}`, p95: f.p95, missedPct: f.missedPct, workP95, walking });
      } finally {
        await walkers.stop();
        await leaveAll(clients);
      }
    }
    for (const r of results) {
      const k = r.row;
      expect(r.p95, `${k} frame p95`).toBeLessThanOrEqual(VSYNC_MS + 1e-6);
      expect(r.missedPct, `${k} missed vsyncs %`).toBeLessThanOrEqual(1);
      expect(r.workP95, `${k} main-thread work p95`).toBeLessThanOrEqual(8);
    }
  });
}
