// M8 Q1 (OME-733): the walk tier choice (ADR 0037, apps/web/src/walk/tier.ts) seen from the browser. walk.e2e.ts covers
// forced Basic/Smooth steps, one odd stored value and reduced motion; this covers the rest: the static gates, forced
// beating the gates, the probe upgrade, the session-long drop, equal arrival times on both tiers, malformed storage.
import { expect, test } from "./support/csp";
import * as v from "valibot";
import type { BrowserContext, Page } from "@playwright/test";
import { PENDING, available } from "./support/apps";
import { joinRoom, leaveAll, testRoom, type Client } from "./support/room";
import { site } from "./support/selectors";

test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);
// The probe reads frame timing, and the trace screencast drops vsyncs on the shared viz thread (ADR 0017): with tracing
// on under the full parallel run it can honestly settle in Basic three room starts in a row.
test.use({ trace: "off" });

let clients: Client[] = [];
test.afterEach(async () => {
  await leaveAll(clients);
  clients = [];
});

const canvas = (page: Page) => page.locator("canvas.scene");
const tierOf = (page: Page): Promise<string | null> => canvas(page).getAttribute("data-motion");

const forceTier = (tier: string) => async (context: BrowserContext): Promise<void> => {
  await context.addInitScript((t) => {
    localStorage.setItem("omega.motion", t);
  }, tier);
};

/** Pretends the device reports `hardwareConcurrency`, `deviceMemory` or Save-Data (the getters tier.ts reads). */
const gate = (g: { cores?: number; memory?: number; saveData?: boolean }) => async (context: BrowserContext): Promise<void> => {
  await context.addInitScript((x) => {
    if (x.cores !== undefined) Object.defineProperty(Navigator.prototype, "hardwareConcurrency", { get: () => x.cores, configurable: true });
    if (x.memory !== undefined) Object.defineProperty(Navigator.prototype, "deviceMemory", { get: () => x.memory, configurable: true });
    if (x.saveData === true) Object.defineProperty(navigator, "connection", { get: () => ({ saveData: true }), configurable: true });
  }, g);
};

const seatSel = (n: number): string => `${site.seat}[data-seat="${String(n)}"]`;

/** Makes `walker` cross the room between the first and the last seat, for `ms`, so the others' avatars keep walking. */
async function walkAround(walker: Client, ms: number, until?: () => Promise<boolean>): Promise<void> {
  const last = (await walker.page.locator(site.seat).count()) - 1;
  const end = Date.now() + ms;
  for (let i = 0; Date.now() < end; i++) {
    await walker.page.locator(seatSel(i % 2 === 0 ? 0 : last)).click();
    await walker.page.waitForTimeout(700);
    if (until !== undefined && (await until())) return;
  }
}

async function joinAgain(page: Page, nickname: string): Promise<void> {
  await page.locator(site.nicknameInput).fill(nickname);
  await page.locator(site.avatarOption).first().click();
  await page.locator(site.joinButton).click();
  await page.locator(site.room).waitFor();
}

/**
 * An unforced, ungated client reaches Smooth once the 30-render probe passes; walks speed the renders up. The probe runs
 * once per room start, so on a box busy with the full parallel suite it can honestly settle in Basic: then reload (a new
 * room start probes again), up to three starts.
 */
async function reachSmooth(walker: Client, observer: Client): Promise<void> {
  for (let start = 0; start < 3; start++) {
    if (start > 0) {
      await observer.page.reload();
      await joinAgain(observer.page, `reprobe-${String(start)}`);
    }
    await walkAround(walker, 15_000, async () => (await tierOf(observer.page)) === "smooth");
    if ((await tierOf(observer.page)) === "smooth") return;
  }
  await expect(canvas(observer.page), "the probe upgraded in one of three room starts").toHaveAttribute("data-motion", "smooth");
}

test("static gates: 2 cores, 2 GB or Save-Data keep the room in Basic through walks; an ungated device probes up to Smooth", async ({ browser }) => {
  test.setTimeout(150_000);
  const url = testRoom("m8-walk", "gates").url;
  const setups: Record<string, (c: BrowserContext) => Promise<void>> = {
    cores: gate({ cores: 2 }),
    memory: gate({ memory: 2 }),
    saveData: gate({ saveData: true }),
  };
  for (const [name, setup] of Object.entries(setups)) {
    clients = await joinRoom(browser, { roomUrl: url, count: 2, nicknamePrefix: `g${name.slice(0, 3)}`, setup });
    const [a, b] = clients;
    if (a === undefined || b === undefined) throw new Error("need two clients");
    await expect(canvas(a.page), `${name}: at start`).toHaveAttribute("data-motion", "basic");
    await a.page.waitForTimeout(6000); // b walked in from the door
    await walkAround(b, 20_000); // far more than the 30 probe renders
    expect(await tierOf(a.page), `${name}: after walks, never probed up`).toBe("basic");
    await leaveAll(clients);
    clients = [];
  }
  // Control: no gate, nothing forced. Headless Chromium here reports plenty of cores and memory, so the probe upgrades.
  clients = await joinRoom(browser, { roomUrl: url, count: 2, nicknamePrefix: "gfree" });
  const [a, b] = clients;
  if (a === undefined || b === undefined) throw new Error("need two clients");
  await expect(canvas(a.page)).toHaveAttribute("data-motion", "basic"); // Basic until the probe has run
  await reachSmooth(b, a);
});

test("a forced tier beats the gates: omega.motion=smooth stays Smooth on 2 cores, 2 GB and Save-Data (tier.ts: forced skips the gates)", async ({ browser }) => {
  clients = await joinRoom(browser, {
    roomUrl: testRoom("m8-walk", "forced").url,
    count: 2,
    nicknamePrefix: "force",
    setup: async (context) => {
      await gate({ cores: 2, memory: 2, saveData: true })(context);
      await forceTier("smooth")(context);
    },
  });
  const [a, b] = clients;
  if (a === undefined || b === undefined) throw new Error("need two clients");
  await expect(canvas(a.page)).toHaveAttribute("data-motion", "smooth");
  await a.page.waitForTimeout(6000);
  await walkAround(b, 8000);
  expect(await tierOf(a.page)).toBe("smooth");
});

// The drop lever. A CDP CPU throttle (Emulation.setCPUThrottlingRate) is applied while avatars walk constantly; tier.ts
// drops when the post-render work p95 of the last 120 Smooth walking renders is over 10 ms. If the throttle alone does
// not get there on a fast box, requestAnimationFrame callbacks also busy-wait (`slowFrames`), which inflates the time
// from a render to its after-paint message the same way a slow device would. `window.__slow` turns the wait off again.
const slowFrames = async (page: Page, busyMs: number): Promise<void> => {
  await page.evaluate((ms) => {
    const raf = window.requestAnimationFrame.bind(window);
    const w = window as unknown as { __slow: boolean };
    w.__slow = true;
    window.requestAnimationFrame = (cb) =>
      raf((t) => {
        cb(t);
        if (!w.__slow) return;
        const end = performance.now() + ms;
        while (performance.now() < end) {
          // busy: a slow device's post-render work
        }
      });
  }, busyMs);
};

test("the probe drop latches for the session: after a Smooth room slows down it stays Basic until reload, which probes again", async ({ browser }) => {
  test.setTimeout(240_000);
  clients = await joinRoom(browser, { roomUrl: testRoom("m8-walk", "latch").url, count: 2, nicknamePrefix: "latch" });
  const [a, b] = clients;
  if (a === undefined || b === undefined) throw new Error("need two clients");
  await reachSmooth(b, a);

  const cdp = await a.context.newCDPSession(a.page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 30 });
  await slowFrames(a.page, 12);
  await walkAround(b, 60_000, async () => (await tierOf(a.page)) === "basic");
  await expect(canvas(a.page), "dropped under load").toHaveAttribute("data-motion", "basic");

  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  await a.page.evaluate(() => {
    (window as unknown as { __slow: boolean }).__slow = false;
  });
  await walkAround(b, 8000); // > 5 s of healthy walking frames
  expect(await tierOf(a.page), "no flip back up within the session").toBe("basic");

  await a.page.reload();
  await joinAgain(a.page, "latch-3");
  await reachSmooth(b, a);
});

const arrivals = v.object({ last: v.number(), final: v.string(), changes: v.number() });

test("both tiers reach the seat at the same time and the same pixel: a Smooth and a Basic observer watch one walker", async ({ browser }) => {
  test.setTimeout(120_000);
  const url = testRoom("m8-walk", "arrival").url;
  const [smooth, basic, walker] = await Promise.all([
    joinRoom(browser, { roomUrl: url, count: 1, nicknamePrefix: "arrs", setup: forceTier("smooth") }),
    joinRoom(browser, { roomUrl: url, count: 1, nicknamePrefix: "arrb", setup: forceTier("basic") }),
    joinRoom(browser, { roomUrl: url, count: 1, nicknamePrefix: "arrw", setup: forceTier("basic") }),
  ]);
  clients = [...smooth, ...basic, ...walker];
  const [s, bs, w] = [smooth[0], basic[0], walker[0]];
  if (s === undefined || bs === undefined || w === undefined) throw new Error("need three clients");
  await expect(canvas(s.page)).toHaveAttribute("data-motion", "smooth");
  await expect(canvas(bs.page)).toHaveAttribute("data-motion", "basic");
  await s.page.waitForTimeout(7000); // the walker walked in from the door

  // In each observer page: when the walker's tag last changed, and where it came to rest (Date.now: one clock for both).
  const watch = async (p: Page): Promise<void> => {
    const tag = p.locator(site.nicknameTag).filter({ hasText: "arrw-1" });
    await expect(tag).toHaveCount(1);
    await tag.evaluate((el) => {
      const rec = { last: 0, final: "", changes: 0 };
      Object.assign(window, { __arrival: rec });
      new MutationObserver(() => {
        rec.last = Date.now();
        rec.final = (el as HTMLElement).style.transform;
        rec.changes++;
      }).observe(el, { attributes: true, attributeFilter: ["style"] });
    });
  };
  await Promise.all([watch(s.page), watch(bs.page)]);
  const read = async (p: Page): Promise<v.InferOutput<typeof arrivals>> =>
    v.parse(arrivals, await p.evaluate(() => (window as unknown as { __arrival: unknown }).__arrival));

  await w.page.locator(seatSel(0)).click();
  await s.page.waitForTimeout(8000);
  const [rs, rb] = await Promise.all([read(s.page), read(bs.page)]);
  expect(rs.changes, "the Smooth observer saw the walk").toBeGreaterThan(10);
  expect(rb.changes, "the Basic observer saw the walk").toBeGreaterThan(3);
  expect(rs.changes, "Smooth moves in finer steps than Basic").toBeGreaterThan(rb.changes);
  expect(rs.final).toBe(rb.final);
  // Same clock, same path: arrival within one 150 ms step of each other (plus network and scheduling slack).
  expect(Math.abs(rs.last - rb.last), `smooth ${String(rs.last)} basic ${String(rb.last)}`).toBeLessThanOrEqual(150 + 150);
});

test("malformed omega.motion values are ignored: the room behaves unforced (Basic on a 2-core device) and logs no errors", async ({ browser }) => {
  test.setTimeout(150_000);
  const url = testRoom("m8-walk", "abuse").url;
  const values = ["SMOOTH", " smooth", '{"x":1}', "x".repeat(10_240), "basic\u0000", "smooth\n", "Basic"];
  for (const [i, value] of values.entries()) {
    const errors: string[] = [];
    clients = await joinRoom(browser, {
      roomUrl: url,
      count: 1,
      nicknamePrefix: `abuse${String(i)}`,
      setup: async (context) => {
        await gate({ cores: 2 })(context);
        await context.addInitScript((val) => {
          try {
            localStorage.setItem("omega.motion", val);
          } catch {
            // opaque-origin frames (about:blank, sandboxed embeds) have no storage; that is not the page under test
          }
        }, value);
        context.on("page", (p) => {
          p.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
          p.on("console", (m) => {
            if (m.type() === "error") errors.push(`console: ${m.text()}`);
          });
        });
      },
    });
    const [a] = clients;
    if (a === undefined) throw new Error("no client");
    // If any of these were honoured as "smooth" the gate would be bypassed and this would read smooth.
    await expect(canvas(a.page), JSON.stringify(value.slice(0, 20))).toHaveAttribute("data-motion", "basic");
    await a.page.waitForTimeout(1500);
    expect(await tierOf(a.page)).toBe("basic");
    expect(errors, JSON.stringify(value.slice(0, 20))).toEqual([]);
    await leaveAll(clients);
    clients = [];
  }
});
