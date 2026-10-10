// OME-601 (M7 W6, ADR 0033, set k `ui-m7-report`): "Report this room". A guest's quiet "Report room" key at the end of the
// room opens a modal dialog; it sends only `{ reason, note? }` to `POST /rooms/:id/report` (no token, no frame), shows
// sent / already reported / rate limited, and the key sinks to "Reported". Owners don't get the key. A takedown (4006) shows
// the ADR's notice, never reconnects, and forgets the room in `omega.rooms`. The dialog's states and the exact body are unit
// tests (apps/web/test/report.test.ts); this spec drives the real page, keyboard only, against the real server.
import type { Page, Request, WebSocketRoute } from "@playwright/test";
import { CLOSE_CODES, ROOM_SECRETS_STORAGE_KEY } from "@omega/shared";
import { expect, test } from "./support/csp";
import { PENDING, URLS, available } from "./support/apps";
import { ownedRoom } from "./support/owned-rooms";
import { joinRoom, leaveAll, testRoom, type Client } from "./support/room";
import { site } from "./support/selectors";
import { testRoomId, type RoomName } from "./support/test-rooms";

test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);

let clients: Client[] = [];
test.afterEach(async () => {
  await leaveAll(clients);
  clients = [];
});

const REPORT_PATH = /\/rooms\/[^/]+\/report$/;

async function join(name: RoomName<"report">, browser: Parameters<typeof joinRoom>[0], setup?: Parameters<typeof joinRoom>[1]["setup"]): Promise<Page> {
  clients = await joinRoom(browser, { roomUrl: testRoom("report", name).url, count: 1, nicknamePrefix: `rp${name}`, ...(setup === undefined ? {} : { setup }) });
  const page = clients[0]?.page;
  if (page === undefined) throw new Error("no client");
  await expect(page.locator(site.connectionStatus)).toHaveText("");
  return page;
}

const focusedTestId = (page: Page): Promise<string | null> => page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? null);
const focusInDialog = (page: Page): Promise<boolean> => page.evaluate(() => document.activeElement?.closest("[data-testid=report-dialog]") != null);

test("a guest reports the room with the keyboard only: the real server gets { reason, note } and nothing else, and the key sinks", async ({ browser }) => {
  const page = await join("send", browser);
  const frames: string[] = [];
  page.on("websocket", (ws) => ws.on("framesent", (f) => {
    if (typeof f.payload === "string") frames.push(f.payload);
  }));
  const reports: Request[] = [];
  page.on("request", (r) => {
    if (REPORT_PATH.test(new URL(r.url()).pathname) && r.method() === "POST") reports.push(r);
  });

  const key = page.locator(site.reportKey);
  await expect(key).toHaveText("Report room");
  // The last tab stop of the room: nothing in the room comes after it.
  const after = await key.evaluate((k) => {
    // The room screen is the page's <main>; the site footer after it is the site's, not the room's.
    const room = k.closest("main");
    if (room === null) return -1;
    const all = [...room.querySelectorAll<HTMLElement>("a[href], button, input, textarea, select, [tabindex]")].filter((e) => !e.closest("[hidden]") && e.tabIndex >= 0 && !(e instanceof HTMLButtonElement && e.disabled) && e.getClientRects().length > 0 && !e.closest("dialog"));
    return k instanceof HTMLElement ? all.length - 1 - all.indexOf(k) : -1;
  });
  expect(after).toBe(0);

  await key.focus();
  await page.keyboard.press("Enter");
  const dialog = page.locator(site.reportDialog);
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await expect(page.getByRole("dialog", { name: "Report this room" })).toBeVisible();
  // Focus opens on the first reason; Send is off until one is picked.
  expect(await focusedTestId(page)).toBe("report-reason");
  await expect(page.locator(site.reportSend)).toBeDisabled();
  // Arrows move and pick within the group.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("radio", { name: "Hate or harassment" })).toBeChecked();
  await page.keyboard.press("Tab");
  expect(await focusedTestId(page)).toBe("report-note");
  await page.keyboard.type("The chat keeps posting slurs at people who join.");
  await expect(page.locator(site.reportCount)).toHaveText("48 / 300");
  await page.keyboard.press("Tab");
  expect(await focusedTestId(page)).toBe("report-cancel");
  await page.keyboard.press("Tab");
  expect(await focusedTestId(page)).toBe("report-send");
  // Focus is trapped: past Send it wraps to the reasons, and back again.
  await page.keyboard.press("Tab");
  expect(await focusInDialog(page)).toBe(true);
  expect(await focusedTestId(page)).toBe("report-reason");
  await page.keyboard.press("Shift+Tab");
  expect(await focusedTestId(page)).toBe("report-send");

  await page.keyboard.press("Enter");
  await expect(page.locator(site.reportSent)).toBeVisible();
  await expect(page.locator(site.reportSent)).toContainText("Thanks, we got it");
  expect(await focusedTestId(page)).toBe("report-close");

  expect(reports).toHaveLength(1);
  const sent = reports[0];
  if (sent === undefined) throw new Error("no report request");
  expect(sent.url()).toBe(`${URLS.server}/rooms/${testRoomId("report", "send")}/report`);
  expect(sent.postDataJSON()).toEqual({ reason: "hate", note: "The chat keeps posting slurs at people who join." });
  const headers = await sent.allHeaders();
  expect(headers["authorization"]).toBeUndefined();
  expect(headers["cookie"]).toBeUndefined();
  expect(headers["referer"]).toBeUndefined();
  expect((await sent.response())?.status()).toBe(202);
  // Nothing about the report went over the room's socket.
  expect(frames.filter((f) => f.includes("report"))).toEqual([]);

  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(key).toHaveText("Reported");
  await expect(key).toHaveAttribute("aria-disabled", "true");
  expect(await focusedTestId(page)).toBe("report-key");
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  // The room kept playing behind it: still in, still connected.
  await expect(page.locator(site.room)).toBeVisible();
  await expect(page.locator(site.connectionStatus)).toHaveText("");
});

test("Esc cancels and gives focus back to the key; already reported and rate limited read plainly", async ({ browser }) => {
  const answers = [
    { status: 429, body: { ok: false, error: { code: "rate_limited", message: "too many", retryAfterMs: 5 * 60_000 } } },
    { status: 200, body: { ok: true, status: "already_reported" } },
  ];
  const page = await join("states", browser, async (context) => {
    await context.route(REPORT_PATH, async (route) => {
      const a = answers.shift();
      if (a === undefined || route.request().method() !== "POST") return route.fallback();
      await route.fulfill({ status: a.status, contentType: "application/json", headers: { "access-control-allow-origin": URLS.web }, body: JSON.stringify(a.body) });
    });
  });
  const key = page.locator(site.reportKey);
  const dialog = page.locator(site.reportDialog);
  await key.focus();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect(await focusedTestId(page)).toBe("report-key");

  // Space picks the focused first reason.
  await page.keyboard.press("Enter");
  await page.keyboard.press("Space");
  await page.locator(site.reportSend).click();
  await expect(page.locator(site.reportFailed)).toBeVisible();
  await expect(page.locator(site.reportFailedText)).toHaveText("Too many reports from here just now. Try again in 5 minutes. Your words are still here.");
  await expect(page.locator(site.reportFailedText)).toHaveAttribute("role", "alert");
  expect(await focusedTestId(page)).toBe("report-retry");
  await page.keyboard.press("Enter");
  await expect(page.locator(site.reportSent)).toBeVisible();
  await expect(page.locator(site.reportAlready)).toHaveText("You already reported this room. One report is enough.");
});

test("an owner gets no Report key in their own room", async ({ browser }) => {
  const { id, ownerToken, inviteKey } = ownedRoom("report");
  clients = await joinRoom(browser, {
    roomUrl: `${URLS.web}/r/${id}`,
    count: 1,
    nicknamePrefix: "rphost",
    setup: async (context) => {
      await context.addInitScript(
        ([origin, k, v]) => {
          if (location.origin === origin && localStorage.getItem(k ?? "") === null) localStorage.setItem(k ?? "", v ?? "");
        },
        [URLS.web, ROOM_SECRETS_STORAGE_KEY, JSON.stringify({ v: 1, rooms: { [id]: { ownerToken, inviteKey } } })],
      );
    },
  });
  const page = clients[0]?.page;
  if (page === undefined) throw new Error("no client");
  await expect(page.locator(site.connectionStatus)).toHaveText("");
  await page.waitForTimeout(300);
  await expect(page.locator(site.reportKey)).toHaveCount(0);
});

test("a takedown (4006) shows the team's notice, never reconnects, forgets the room, and opening it again says 'Room not found'", async ({ browser }) => {
  const roomId = testRoomId("report", "gone");
  const routes: WebSocketRoute[] = [];
  let takenDown = false;
  const page = await join("gone", browser, async (context) => {
    // The browser remembers an invite key for this room, as after following an invite link.
    await context.addInitScript(
      ([origin, k, v]) => {
        if (location.origin === origin && localStorage.getItem(k ?? "") === null) localStorage.setItem(k ?? "", v ?? "");
      },
      [URLS.web, ROOM_SECRETS_STORAGE_KEY, JSON.stringify({ v: 1, rooms: { [roomId]: { inviteKey: "QaInviteKey-gone".padEnd(22, "y") } } })],
    );
    // The operator's takedown ends the room with 4006 (S1); here the route plays the server's part once we're in.
    await context.routeWebSocket(/\/rooms\/[^/]+\/ws$/, (ws) => {
      routes.push(ws);
      if (takenDown) {
        void ws.close({ code: CLOSE_CODES.TAKEN_DOWN, reason: "taken down" });
        return;
      }
      ws.connectToServer();
    });
  });
  expect(routes).toHaveLength(1);
  // Taken down while the guest has the dialog open (QA OME-640): the dialog goes and focus lands on the notice, not <body>.
  await page.locator(site.reportKey).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(site.reportDialog)).toBeVisible();
  await page.keyboard.press("ArrowDown");
  takenDown = true;
  await routes[0]?.close({ code: CLOSE_CODES.TAKEN_DOWN, reason: "taken down" });

  const notice = page.locator(site.roomClosed);
  await expect(notice).toBeVisible();
  await expect(page.locator(site.reportDialog)).toBeHidden();
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest("[data-testid=room-closed]") != null)).toBe(true);
  await expect(notice).toHaveAttribute("data-reason", "taken-down");
  await expect(notice).toContainText("This room was closed by the omega-share team after a report.");
  await expect(page.locator(site.reportKey)).toBeHidden();
  await page.waitForTimeout(1500);
  expect(routes).toHaveLength(1);
  const remembered = await page.evaluate((k) => localStorage.getItem(k), ROOM_SECRETS_STORAGE_KEY);
  expect(remembered ?? "").not.toContain(roomId);

  // Opening /r/<id> later: the join is closed with 4006 before any snapshot, and the page says "Room not found" (OME-768).
  await page.reload();
  await page.locator(site.nicknameInput).fill("rpgone-2");
  await page.locator(site.joinButton).click();
  await expect(page.locator(site.notFound)).toBeVisible();
  await expect(page.locator(site.notFound)).toContainText("This room doesn't exist or was taken down");
  await expect(notice).toBeHidden();
  await page.waitForTimeout(1500);
  expect(routes).toHaveLength(2);
});
