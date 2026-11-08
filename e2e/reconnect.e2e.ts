// OME-1248 (QA research OME-1243 R1–R3): what a dropped socket looks like from the chat. Say is held while
// reconnecting and the text waits in the field; the log says once that chat sent meanwhile isn't shown; the window's
// `online` event reconnects at once instead of waiting out the backoff.
import type { WebSocketRoute } from "@playwright/test";
import { expect, test } from "./support/csp";
import { PENDING, available } from "./support/apps";
import { joinRoom, leaveAll, testRoom, type Client } from "./support/room";
import { site } from "./support/selectors";
import { PAUSED, fakeState, roomPlayback, shareVideo, waitPlaying } from "../perf/sync";

test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);

let clients: Client[] = [];
test.afterEach(async () => {
  await leaveAll(clients);
  clients = [];
});

declare global {
  interface Window {
    /** OME-2425: when the connection status first showed text after the socket went dark. */
    __statusAt?: number;
  }
}

const GAP = "You were disconnected; messages sent meanwhile aren't shown";

test("a drop: Say is held, one gap line after the rejoin, and `online` reconnects within 1 s", async ({ browser }) => {
  // A's room sockets: proxied while `up`, refused (closed before reaching the server) while not.
  let up = true;
  const routes: WebSocketRoute[] = [];
  const opened: number[] = [];
  clients = await joinRoom(browser, {
    roomUrl: testRoom("reconnect", "main").url,
    count: 2,
    nicknamePrefix: "rc",
    setup: async (context, i) => {
      if (i !== 0) return;
      await context.routeWebSocket(/\/rooms\/[^/]+\/ws$/, (ws) => {
        opened.push(Date.now());
        routes.push(ws);
        if (up) ws.connectToServer();
        else void ws.close({ code: 4000, reason: "offline" });
      });
    },
  });
  const [a, b] = clients;
  if (a === undefined || b === undefined) throw new Error("no clients");
  await expect(a.page.locator(site.nicknameTag)).toHaveCount(2);
  await b.page.locator(site.chatInput).fill("before");
  await b.page.locator(site.chatSend).click();
  await expect(a.page.locator(site.chatLog)).toContainText("before");

  // Drop A and keep it out for a few attempts, so the pending backoff is seconds long.
  up = false;
  await routes.at(-1)?.close({ code: 4000, reason: "drop" });
  await expect(a.page.locator(site.connectionStatus)).not.toHaveText("");
  await expect.poll(() => opened.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(5);

  // R1: Say is held; Enter keeps the text in the field.
  await expect(a.page.locator(site.chatSend)).toBeDisabled();
  await a.page.locator(site.chatInput).fill("typed offline");
  await a.page.locator(site.chatInput).press("Enter");
  await expect(a.page.locator(site.chatInput)).toHaveValue("typed offline");

  // R2: B speaks during the drop; A never sees it.
  await b.page.locator(site.chatInput).fill("during the drop");
  await b.page.locator(site.chatSend).click();

  // R3: the network is back and the window says so; the next socket opens well before the backoff would.
  const before = opened.length;
  up = true;
  const at = Date.now();
  await a.page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(() => opened.length, { timeout: 1000, intervals: [50] }).toBeGreaterThan(before);
  expect((opened[before] ?? Infinity) - at).toBeLessThan(1000);
  await expect(a.page.locator(site.connectionStatus)).toHaveText("");

  // Exactly one gap line, no duplicated lines, and the held text goes now.
  await expect(a.page.locator(site.chatLogLine).filter({ hasText: GAP })).toHaveCount(1);
  await expect(a.page.locator(site.chatSend)).toBeEnabled();
  await a.page.locator(site.chatSend).click();
  await expect(b.page.locator(site.chatLog)).toContainText("typed offline");
  await expect(a.page.locator(site.chatLog)).toContainText("typed offline");
  const lines = await a.page.locator(site.chatLogLine).allTextContents();
  expect(lines.filter((l) => l.includes(GAP))).toHaveLength(1);
  expect(lines.filter((l) => l.includes("before"))).toHaveLength(1);
  expect(lines.some((l) => l.includes("during the drop"))).toBe(false);
});

// OME-2425 (audit OME-2420 #2): a socket that dies without a close. Every frame is dropped both ways, no close, no
// `offline`: the page notices the silence, keeps the line sent meanwhile, and catches up with the room on the rejoin.
test("a blackholed socket: reconnecting within 10 s, the unanswered line is resent, playback matches within 1 s", async ({ browser, request }) => {
  test.setTimeout(60_000);
  const room = testRoom("reconnect", "dark");
  await shareVideo(request, room.id);
  let dark: WebSocketRoute | null = null;
  const routes: WebSocketRoute[] = [];
  clients = await joinRoom(browser, {
    roomUrl: room.url,
    count: 2,
    nicknamePrefix: "bh",
    setup: async (context, i) => {
      if (i !== 0) return;
      await context.routeWebSocket(/\/rooms\/[^/]+\/ws$/, (ws) => {
        routes.push(ws);
        const server = ws.connectToServer();
        // Proxied by hand so a blackholed route can swallow frames; closes still pass both ways (nobody sends one).
        ws.onMessage((m) => {
          if (dark !== ws) server.send(m);
        });
        server.onMessage((m) => {
          if (dark !== ws) ws.send(m);
        });
      });
    },
  });
  const [a, b] = clients;
  if (a === undefined || b === undefined) throw new Error("no clients");
  await waitPlaying(clients);

  // The reconnecting status may last well under a poll interval, so the page records when it first shows.
  await a.page.evaluate((selector) => {
    const el = document.querySelector(selector);
    if (el === null) throw new Error("no status");
    new MutationObserver(() => {
      if (el.textContent !== "" && window.__statusAt === undefined) window.__statusAt = Date.now();
    }).observe(el, { childList: true, characterData: true, subtree: true });
  }, site.connectionStatus);
  dark = routes.at(-1) ?? null;
  const darkAt = Date.now();
  const before = routes.length;
  // A speaks into the void before anything notices; B pauses the room meanwhile.
  await a.page.locator(site.chatInput).fill("into the void");
  await a.page.locator(site.chatInput).press("Enter");
  await b.page.locator(site.playToggle).click();
  await expect.poll(() => fakeState(b.page)).toBe(PAUSED);

  // 1. Reconnecting shows within 10 s of the silence.
  await expect.poll(() => a.page.evaluate(() => window.__statusAt ?? null), { timeout: 10_000, intervals: [100] }).not.toBeNull();
  expect((await a.page.evaluate(() => window.__statusAt ?? Infinity)) - darkAt).toBeLessThan(10_000);

  // 3. Within 1 s of the rejoin, A's player is paused where the room is.
  await expect.poll(() => routes.length, { timeout: 10_000, intervals: [50] }).toBeGreaterThan(before);
  await expect.poll(() => fakeState(a.page), { timeout: 1500, intervals: [50] }).toBe(PAUSED);
  const p = await roomPlayback(browser, room.id);
  expect(p.playing).toBe(false);
  const actual = await a.page.evaluate(() => window.__fakeYt?.currentTime ?? null);
  expect(Math.abs((actual ?? Infinity) - p.position)).toBeLessThanOrEqual(1);
  await expect(a.page.locator(site.connectionStatus)).toHaveText("");

  // 2. The line the room never got arrives after the rejoin, once.
  await expect(b.page.locator(site.chatLog)).toContainText("into the void");
  await expect(a.page.locator(site.chatLogLine).filter({ hasText: "into the void" })).toHaveCount(1);
});
