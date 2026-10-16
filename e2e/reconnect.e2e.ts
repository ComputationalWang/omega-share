// OME-1248 (QA research OME-1243 R1–R3): what a dropped socket looks like from the chat. Say is held while
// reconnecting and the text waits in the field; the log says once that chat sent meanwhile isn't shown; the window's
// `online` event reconnects at once instead of waiting out the backoff.
import type { WebSocketRoute } from "@playwright/test";
import { expect, test } from "./support/csp";
import { PENDING, available } from "./support/apps";
import { joinRoom, leaveAll, testRoom, type Client } from "./support/room";
import { site } from "./support/selectors";

test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);

let clients: Client[] = [];
test.afterEach(async () => {
  await leaveAll(clients);
  clients = [];
});

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
