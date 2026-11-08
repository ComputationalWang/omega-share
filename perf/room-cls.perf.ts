// OME-2106: Cumulative Layout Shift in the room over one full-screen enter + exit, a video shared, one client per profile
// (desktop Chromium, a Pixel 7 in landscape 915×412 and in portrait 412×915). In by our full-screen key, out the way Esc,
// the browser's UI or Android Back leave (`document.exitFullscreen()`: no input on the page, so every shift counts).
// Every layout shift without recent input from the key press until 1 s after leaving, summed (as the landing rows count it).
// Rows: room.fsCls.<profile> (< 0.01). The note names the elements that moved.
import { devices, expect, test } from "@playwright/test";
import type { BrowserContextOptions, Page } from "@playwright/test";
import { PENDING, available } from "../e2e/support/apps";
import { EMBED_URL } from "../e2e/support/network";
import { joinRoom, leaveAll, testRoom } from "../e2e/support/room";
import { site } from "../e2e/support/selectors";
import { joinForToken, postShare } from "../e2e/support/share";
import { BUDGETS, evaluate } from "./budgets";
import { recordMetric } from "./metrics";
import { waitPlaying } from "./sync";

const PROFILES = {
  desktop: undefined,
  landscape: { ...devices["Pixel 7"], viewport: { width: 915, height: 412 } },
  portrait: { ...devices["Pixel 7"], viewport: { width: 412, height: 915 } },
} satisfies Record<string, BrowserContextOptions | undefined>;
/** How long after a toggle the browser's resize, our relayout and the strip's move may still be running. */
const SETTLE_MS = 1000;
const LIMIT = 0.01;

const inFullscreen = (page: Page): Promise<boolean> => page.evaluate(() => document.fullscreenElement !== null);

async function settle(page: Page, on: boolean): Promise<void> {
  await expect.poll(() => inFullscreen(page)).toBe(on);
  await page.waitForTimeout(SETTLE_MS);
}

for (const profile of ["desktop", "landscape", "portrait"] as const) {
  const options = PROFILES[profile];
  test(`room CLS over a full-screen enter + exit, ${profile}`, async ({ browser, request }) => {
    const id = `room.fsCls.${profile}`;
    const why = !available.web ? PENDING.web : !available.server ? PENDING.server : null;
    if (why !== null) {
      recordMetric({ id, pending: why });
      test.skip(true, why);
      return;
    }
    test.setTimeout(120_000);
    const room = testRoom("room-cls-perf", profile);
    await expect
      .poll(
        async () => {
          const member = await joinForToken(room.id, "cls-perf-sharer");
          try {
            return (await postShare(request, room.id, member.token, EMBED_URL)).status();
          } finally {
            member.close();
          }
        },
        { timeout: 60_000, intervals: [2_000, 5_000] },
      )
      .toBe(200);
    const clients = await joinRoom(browser, { roomUrl: room.url, count: 1, nicknamePrefix: "cls", contextOptions: () => options });
    try {
      await waitPlaying(clients);
      const page = clients[0]?.page;
      if (page === undefined) throw new Error("no client");
      await page.waitForTimeout(SETTLE_MS);
      await page.evaluate(() => {
        const shifts: { value: number; nodes: string[] }[] = [];
        Reflect.set(window, "__roomShifts", shifts);
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            const s = e as PerformanceEntry & { value: number; hadRecentInput: boolean; sources?: { node?: Node | null }[] };
            if (s.hadRecentInput) continue;
            const nodes = (s.sources ?? []).map(({ node }) => (node instanceof Element ? `${node.localName}${node.className === "" ? "" : `.${node.className.trim().split(/\s+/).join(".")}`}` : "?"));
            shifts.push({ value: s.value, nodes });
          }
        }).observe({ type: "layout-shift" });
      });
      await page.locator(site.fullscreenToggle).click();
      await settle(page, true);
      await page.evaluate(() => document.exitFullscreen());
      await settle(page, false);
      const shifts = await page.evaluate(() => {
        const seen: unknown = Reflect.get(window, "__roomShifts");
        return Array.isArray(seen) ? (seen as { value: number; nodes: string[] }[]) : [];
      });
      const cls = shifts.reduce((sum, s) => sum + s.value, 0);
      const moved = [...new Set(shifts.flatMap((s) => s.nodes))];
      recordMetric({ id, value: cls, note: `${String(shifts.length)} shifts${moved.length > 0 ? ` (${moved.join(", ")})` : ""}; ${profile}, one full-screen enter + exit, video shared` });
      expect(cls, moved.join(", ")).toBeLessThan(LIMIT);
    } finally {
      await leaveAll(clients);
    }
  });
}

// OME-2261: CLS loading a room cold. A guest joins, then reloads `/r/<id>` (a returning guest, no input); every layout shift
// from navigation start until the room has drawn and 2 s after, summed. Rows: room.coldCls.desktop (1280×800), room.coldCls.phone4x.
// OME-2281: room.coldCls.phoneLate, the same phone with the room chunk and every server message held 1.5 s: the page paints
// before the room settles (as a slow real phone does under load), so the late portrait dock and footer stow count;
// room.coldCls.landscapeLate, the same held sideways (915×412).
const COLD = [
  { id: "room.coldCls.desktop", options: { viewport: { width: 1280, height: 800 } }, cpu: 1, holdMs: 0 },
  { id: "room.coldCls.phone4x", options: devices["Pixel 7"], cpu: 4, holdMs: 0 },
  { id: "room.coldCls.phoneLate", options: devices["Pixel 7"], cpu: 4, holdMs: 1500 },
  { id: "room.coldCls.landscapeLate", options: PROFILES.landscape, cpu: 4, holdMs: 1500 },
] as const;
const COLD_SETTLE_MS = 2000;

for (const p of COLD) {
  test(`room CLS loading cold, ${p.id}`, async ({ browser }) => {
    const why = !available.web ? PENDING.web : !available.server ? PENDING.server : null;
    if (why !== null) {
      recordMetric({ id: p.id, pending: why });
      test.skip(true, why);
      return;
    }
    test.setTimeout(120_000);
    const room = testRoom("room-cls-perf", p.id.endsWith("desktop") ? "cold-desktop" : "cold-phone");
    const [client] = await joinRoom(browser, { roomUrl: room.url, count: 1, nicknamePrefix: "cold", contextOptions: () => p.options });
    try {
      const page = client?.page;
      if (page === undefined) throw new Error("no client");
      // From the first script of the reloaded document, so the load's own shifts count.
      await page.context().addInitScript(() => {
        const shifts: { value: number; nodes: string[] }[] = [];
        Reflect.set(window, "__roomShifts", shifts);
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            const s = e as PerformanceEntry & { value: number; hadRecentInput: boolean; sources?: { node?: Node | null }[] };
            if (s.hadRecentInput) continue;
            const nodes = (s.sources ?? []).map(({ node }) => (node instanceof Element ? `${node.localName}${node.className === "" ? "" : `.${node.className.trim().split(/\s+/).join(".")}`}` : "?"));
            shifts.push({ value: s.value, nodes });
          }
        }).observe({ type: "layout-shift", buffered: true });
      });
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: p.cpu });
      if (p.holdMs > 0) {
        await page.route(/\/assets\/room-[^/]*\.js$/, async (route) => {
          await new Promise((r) => setTimeout(r, p.holdMs));
          await route.continue();
        });
        await page.routeWebSocket(/./, (ws) => {
          const server = ws.connectToServer();
          server.onMessage((m) => setTimeout(() => { ws.send(m); }, p.holdMs));
        });
      }
      await page.reload();
      await expect(page.locator(site.room)).toBeVisible({ timeout: 60_000 });
      await page.waitForTimeout(COLD_SETTLE_MS * p.cpu + p.holdMs);
      const shifts = await page.evaluate(() => {
        const seen: unknown = Reflect.get(window, "__roomShifts");
        return Array.isArray(seen) ? (seen as { value: number; nodes: string[] }[]) : [];
      });
      const value = shifts.reduce((sum, s) => sum + s.value, 0);
      const moved = [...new Set(shifts.flatMap((s) => s.nodes))];
      const m = { id: p.id, value, note: `${String(shifts.length)} shifts${moved.length > 0 ? ` (${moved.join(", ")})` : ""}; reload of /r/<id>, returning guest` };
      recordMetric(m);
      const budget = BUDGETS.find((b) => b.id === p.id);
      if (!budget) throw new Error(`no budget ${p.id}`);
      expect(evaluate(budget, m).status, `${budget.metric}: ${value.toFixed(3)} vs ${budget.comparator} ${String(budget.limit)} (${m.note})`).toBe("pass");
    } finally {
      await leaveAll([...(client ? [client] : [])]);
    }
  });
}

// OME-2345: CLS on an observer while another member starts a video in an empty room and then skips once. The observer joins
// first (no input afterwards); the actor pastes two links (the first add starts the video, ADR 0031 §5) and presses "Play next now".
// Every layout shift from the first paste until 2 s after the skip, summed. Rows: room.observerCls.<profile> (< 0.01).
const OBSERVER = {
  desktop: { viewport: { width: 1280, height: 800 } },
  portrait: { ...devices["Pixel 7"], viewport: { width: 412, height: 915 } },
  landscape: { ...devices["Pixel 7"], viewport: { width: 915, height: 412 } },
} satisfies Record<string, BrowserContextOptions>;
const OBSERVER_SETTLE_MS = 2000;
const SECOND_URL = "https://www.youtube.com/embed/dQw4w9WgXcQ";

for (const profile of ["desktop", "portrait", "landscape"] as const) {
  test(`room CLS on an observer while another member starts a video and skips, ${profile}`, async ({ browser }) => {
    const id = `room.observerCls.${profile}`;
    const why = !available.web ? PENDING.web : !available.server ? PENDING.server : null;
    if (why !== null) {
      recordMetric({ id, pending: why });
      test.skip(true, why);
      return;
    }
    test.setTimeout(120_000);
    const room = testRoom("room-cls-perf", `obs-${profile}`);
    const [observer, actor] = await joinRoom(browser, { roomUrl: room.url, count: 2, nicknamePrefix: "obs", contextOptions: (i) => (i === 0 ? OBSERVER[profile] : OBSERVER.desktop) });
    try {
      if (observer === undefined || actor === undefined) throw new Error("no clients");
      // The queue's field is in the actor's Up next tab (OME-2306): its page, not the observer's, so nothing measured moves.
      await actor.page.getByTestId("portrait-queue").click();
      await observer.page.waitForTimeout(OBSERVER_SETTLE_MS);
      await observer.page.evaluate(() => {
        const shifts: { value: number; nodes: string[] }[] = [];
        Reflect.set(window, "__roomShifts", shifts);
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            const s = e as PerformanceEntry & { value: number; hadRecentInput: boolean; sources?: { node?: Node | null }[] };
            if (s.hadRecentInput) continue;
            const nodes = (s.sources ?? []).map(({ node }) => (node instanceof Element ? `${node.localName}${node.className === "" ? "" : `.${node.className.trim().split(/\s+/).join(".")}`}` : "?"));
            shifts.push({ value: s.value, nodes });
          }
        }).observe({ type: "layout-shift" });
      });
      for (const url of [EMBED_URL, SECOND_URL]) {
        await actor.page.locator(site.queueUrl).fill(url);
        await actor.page.locator(site.queueAdd).click();
        await actor.page.waitForTimeout(OBSERVER_SETTLE_MS);
      }
      await waitPlaying([observer]);
      await actor.page.locator(site.queueNext).click();
      await observer.page.waitForTimeout(OBSERVER_SETTLE_MS);
      const shifts = await observer.page.evaluate(() => {
        const seen: unknown = Reflect.get(window, "__roomShifts");
        return Array.isArray(seen) ? (seen as { value: number; nodes: string[] }[]) : [];
      });
      const cls = shifts.reduce((sum, s) => sum + s.value, 0);
      const moved = [...new Set(shifts.flatMap((s) => s.nodes))];
      recordMetric({ id, value: cls, note: `${String(shifts.length)} shifts${moved.length > 0 ? ` (${moved.join(", ")})` : ""}; ${profile} observer, another member starts a video and skips once` });
      expect(cls, moved.join(", ")).toBeLessThan(LIMIT);
    } finally {
      await leaveAll([...(observer && actor ? [observer, actor] : [])]);
    }
  });
}

// OME-2382: CLS on a member who never types during a chat burst. Five members send 3 lines each, 300 ms apart (rounds of five,
// each sender under the chat bucket's 5); the sixth, who never types, measures every layout shift from the first line until 2 s after the last.
// Rows: room.chatCls.<profile> (< 0.01).
for (const profile of ["desktop", "portrait", "landscape"] as const) {
  test(`room CLS on a member who never types during a chat burst, ${profile}`, async ({ browser }) => {
    const id = `room.chatCls.${profile}`;
    const why = !available.web ? PENDING.web : !available.server ? PENDING.server : null;
    if (why !== null) {
      recordMetric({ id, pending: why });
      test.skip(true, why);
      return;
    }
    test.setTimeout(120_000);
    const room = testRoom("room-cls-perf", `chat-${profile}`);
    const [observer, ...senders] = await joinRoom(browser, { roomUrl: room.url, count: 6, nicknamePrefix: "chatcls", contextOptions: (i) => (i === 0 ? OBSERVER[profile] : OBSERVER.desktop) });
    try {
      if (observer === undefined || senders.length !== 5) throw new Error("no clients");
      await observer.page.waitForTimeout(OBSERVER_SETTLE_MS);
      await observer.page.evaluate(() => {
        const shifts: { value: number; nodes: string[] }[] = [];
        Reflect.set(window, "__roomShifts", shifts);
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            const s = e as PerformanceEntry & { value: number; hadRecentInput: boolean; sources?: { node?: Node | null }[] };
            if (s.hadRecentInput) continue;
            const nodes = (s.sources ?? []).map(({ node }) => (node instanceof Element ? `${node.localName}${node.className === "" ? "" : `.${node.className.trim().split(/\s+/).join(".")}`}` : "?"));
            shifts.push({ value: s.value, nodes });
          }
        }).observe({ type: "layout-shift" });
      });
      for (let line = 0; line < 3; line++) {
        for (const s of senders) {
          const input = s.page.locator(site.chatInput);
          await input.fill(`burst ${s.nickname} ${String(line)}`);
          await input.press("Enter");
          await observer.page.waitForTimeout(300);
        }
      }
      await observer.page.waitForTimeout(OBSERVER_SETTLE_MS);
      await expect(observer.page.locator(site.chatLogLine).filter({ hasText: "burst" })).toHaveCount(15);
      const shifts = await observer.page.evaluate(() => {
        const seen: unknown = Reflect.get(window, "__roomShifts");
        return Array.isArray(seen) ? (seen as { value: number; nodes: string[] }[]) : [];
      });
      const cls = shifts.reduce((sum, s) => sum + s.value, 0);
      const moved = [...new Set(shifts.flatMap((s) => s.nodes))];
      recordMetric({ id, value: cls, note: `${String(shifts.length)} shifts${moved.length > 0 ? ` (${moved.join(", ")})` : ""}; ${profile} member who never types, 5 members × 3 lines 300 ms apart` });
      expect(cls, moved.join(", ")).toBeLessThan(LIMIT);
    } finally {
      await leaveAll([...(observer ? [observer, ...senders] : [])]);
    }
  });
}

// OME-2426: CLS on an observer through a server restart (drop + rejoin). The observer reloads behind a WebSocket proxy, then its
// socket is closed with 1012 and every reconnect refused for DROP_MS, then let through to the real server (seat held, so a rejoin).
// Every layout shift from the drop until 2 s after the connection line is gone, summed. Rows: room.restartCls.<profile> (< 0.01).
const DROP_MS = 5000;

for (const profile of ["desktop", "portrait", "landscape"] as const) {
  test(`room CLS on an observer through a server restart, ${profile}`, async ({ browser }) => {
    const id = `room.restartCls.${profile}`;
    const why = !available.web ? PENDING.web : !available.server ? PENDING.server : null;
    if (why !== null) {
      recordMetric({ id, pending: why });
      test.skip(true, why);
      return;
    }
    test.setTimeout(120_000);
    const room = testRoom("room-cls-perf", `rs-${profile}`);
    const [observer] = await joinRoom(browser, { roomUrl: room.url, count: 1, nicknamePrefix: "restart", contextOptions: () => OBSERVER[profile] });
    try {
      if (observer === undefined) throw new Error("no client");
      const page = observer.page;
      let refuse = false;
      let live: { close: (o: { code: number }) => void } | undefined;
      await page.routeWebSocket(/./, (ws) => {
        if (refuse) {
          ws.close({ code: 1012 });
          return;
        }
        ws.connectToServer();
        live = ws;
      });
      await page.reload();
      await expect(page.locator(site.room)).toBeVisible({ timeout: 60_000 });
      await page.waitForTimeout(OBSERVER_SETTLE_MS);
      await page.evaluate(() => {
        const shifts: { value: number; nodes: string[] }[] = [];
        Reflect.set(window, "__roomShifts", shifts);
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            const s = e as PerformanceEntry & { value: number; hadRecentInput: boolean; sources?: { node?: Node | null }[] };
            if (s.hadRecentInput) continue;
            const nodes = (s.sources ?? []).map(({ node }) => (node instanceof Element ? `${node.localName}${node.className === "" ? "" : `.${node.className.trim().split(/\s+/).join(".")}`}` : "?"));
            shifts.push({ value: s.value, nodes });
          }
        }).observe({ type: "layout-shift" });
      });
      refuse = true;
      live?.close({ code: 1012 });
      await page.waitForTimeout(DROP_MS);
      refuse = false;
      await expect(page.locator(site.connectionStatus)).toHaveText("", { timeout: 60_000 });
      await page.waitForTimeout(OBSERVER_SETTLE_MS);
      const shifts = await page.evaluate(() => {
        const seen: unknown = Reflect.get(window, "__roomShifts");
        return Array.isArray(seen) ? (seen as { value: number; nodes: string[] }[]) : [];
      });
      const cls = shifts.reduce((sum, s) => sum + s.value, 0);
      const moved = [...new Set(shifts.flatMap((s) => s.nodes))];
      recordMetric({ id, value: cls, note: `${String(shifts.length)} shifts${moved.length > 0 ? ` (${moved.join(", ")})` : ""}; ${profile} observer, socket closed 1012 and reconnects refused ${String(DROP_MS / 1000)} s` });
      expect(cls, moved.join(", ")).toBeLessThan(LIMIT);
    } finally {
      await leaveAll(observer ? [observer] : []);
    }
  });
}
