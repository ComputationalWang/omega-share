// "Up next" against the real server (OME-508, ADR 0031): paste a link (checked by the share parser before anything is
// sent), the list on every client, remove, play next, the advance when the players reach the end (each client reports
// `ended` once), one panel redraw per queue change, and a generic item that stays click-to-load after it becomes current.
// Fake SDKs (OME-121). Runs in `e2e-sync` with the other provider-* specs: it drives playback in rooms of its own.
import type { BrowserContext, Page } from "@playwright/test";
import * as v from "valibot";
import { expect, test } from "./support/csp";
import { PENDING, available } from "./support/apps";
import { VIDEO_ID, WATCH_URL } from "./support/network";
import { joinRoom, leaveAll, testRoom, type Client } from "./support/room";
import { site } from "./support/selectors";

test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);

const OTHER_ID = "dQw4w9WgXcQ";
const OTHER_URL = `https://www.youtube.com/watch?v=${OTHER_ID}`;
const VIMEO_URL = "https://vimeo.com/76979871";
const GENERIC_HOST = "video.omega-fixture.org";
const GENERIC_URL = `https://${GENERIC_HOST}/embed/42`;

let clients: Client[] = [];
test.afterEach(async () => {
  await leaveAll(clients);
  clients = [];
});

type Sent = { type: string; [k: string]: unknown }[];

/** Frames a page sends on its room socket, parsed. Hook it before the page opens: the socket starts on join. */
function captureSent(page: Page, sent: Sent): void {
  page.on("websocket", (ws) =>
    ws.on("framesent", (f) => {
      if (typeof f.payload !== "string") return;
      const m: unknown = JSON.parse(f.payload);
      if (typeof m === "object" && m !== null && typeof Reflect.get(m, "type") === "string") sent.push(m as { type: string });
    }),
  );
}

/** One frame log per client, filled from the moment its page opens. */
function sentLogs(count: number): { logs: Sent[]; setup: (context: BrowserContext, i: number) => Promise<void> } {
  const logs: Sent[] = Array.from({ length: count }, () => []);
  return {
    logs,
    setup: (context, i) => {
      context.on("page", (p) => {
        const log = logs[i];
        if (log !== undefined) captureSent(p, log);
      });
      return Promise.resolve();
    },
  };
}

/** The dev handle (apps/web/src/main.ts `window.__omega.room`): one of its read-outs. */
async function handle(page: Page, read: "itemId" | "queueRenders"): Promise<unknown> {
  return page.evaluate((read) => {
    const debug: unknown = Reflect.get(window, "__omega");
    const room: unknown = typeof debug === "object" && debug !== null ? Reflect.get(debug, "room") : null;
    if (typeof room !== "object" || room === null) return null;
    if (read === "queueRenders") {
      const f: unknown = Reflect.get(room, "queueRenders");
      return typeof f === "function" ? (Reflect.apply(f, room, []) as unknown) : null;
    }
    const state: unknown = Reflect.get(room, "state");
    const s: unknown = typeof state === "function" ? Reflect.apply(state, room, []) : null;
    const r: unknown = typeof s === "object" && s !== null ? Reflect.get(s, "room") : null;
    return typeof r === "object" && r !== null ? (Reflect.get(r, "itemId") as unknown) : null;
  }, read);
}
const itemId = async (page: Page): Promise<string | null> => v.parse(v.nullable(v.string()), (await handle(page, "itemId")) ?? null);
const renders = async (page: Page): Promise<number> => v.parse(v.number(), await handle(page, "queueRenders"));

async function paste(page: Page, url: string): Promise<void> {
  await page.locator(site.queueUrl).fill(url);
  await page.locator(site.queueAdd).click();
}

/**
 * Put `url` on the TV through the queue. Into an empty room the add starts it (ADR 0031 §5 amendment); a room left
 * playing by an earlier attempt (a retry, --repeat-each) gets it queued, so play next brings it on.
 */
async function startWith(page: Page, url: string): Promise<void> {
  const busy = (await itemId(page)) !== null;
  await paste(page, url);
  if (!busy) return;
  await expect(page.locator(site.queueRow).last()).toBeVisible();
  while ((await page.locator(site.queueRow).count()) > 0) {
    const before = await page.locator(site.queueRow).count();
    await page.locator(site.queueNext).click();
    await expect(page.locator(site.queueRow)).toHaveCount(before - 1);
  }
}

const tvShows = (page: Page, videoId: string) => expect(page.locator(site.sharedVideo)).toHaveAttribute("src", new RegExp(`/embed/${videoId}`));

test("paste a link, everyone sees the list, remove your own row, play next now", async ({ browser }) => {
  test.setTimeout(90_000);
  const { logs, setup } = sentLogs(2);
  clients = await joinRoom(browser, { roomUrl: testRoom("provider-queue", "main").url, count: 2, nicknamePrefix: "q", setup });
  const [a, b] = clients;
  const aSent = logs[0];
  if (a === undefined || b === undefined || aSent === undefined) throw new Error("need two clients");
  await expect(a.page.locator(site.queuePanel)).toBeVisible();
  await expect(a.page.locator(site.queueCount)).toHaveText("0 / 20");

  // Refused before it's sent, with the parser's reason; the link stays in the field.
  await paste(a.page, "ftp://files.local/movie.mkv");
  await expect(a.page.locator(site.queueProblem)).toHaveText("That link can't play here. Try a video page's https link.");
  await expect(a.page.locator(site.queueUrl)).toHaveAttribute("aria-invalid", "true");
  await a.page.waitForTimeout(300);
  expect(aSent.filter((m) => m.type === "queue-add")).toEqual([]);

  // Into an empty room the first link starts playing (ADR 0031 §5 amendment); the next ones queue up.
  await startWith(a.page, WATCH_URL);
  for (const c of clients) await tvShows(c.page, VIDEO_ID);
  expect(aSent.filter((m) => m.type === "queue-add").length).toBeGreaterThan(0);
  await paste(a.page, VIMEO_URL);
  await paste(b.page, OTHER_URL);
  for (const c of clients) {
    await expect(c.page.locator(site.queueRow)).toHaveCount(2);
    await expect(c.page.locator(site.queueCount)).toHaveText("2 / 20");
    await expect(c.page.locator(site.queueRow).first()).toHaveClass(/is-next/);
    await expect(c.page.locator(site.queueRow).first()).toContainText("Vimeo video 76979871");
  }
  // × only on your own rows (the host's would have one on every row).
  await expect(a.page.locator(`${site.queueRow}:nth-child(1) ${site.queueRemove}`)).toHaveCount(1);
  await expect(a.page.locator(`${site.queueRow}:nth-child(2) ${site.queueRemove}`)).toHaveCount(0);
  await expect(b.page.locator(`${site.queueRow}:nth-child(1) ${site.queueRemove}`)).toHaveCount(0);

  // One queue change, one redraw on a client that didn't make it.
  const before = await renders(b.page);
  await a.page.locator(`${site.queueRow}:nth-child(1) ${site.queueRemove}`).click();
  for (const c of clients) await expect(c.page.locator(site.queueRow)).toHaveCount(1);
  await b.page.waitForTimeout(500);
  expect(await renders(b.page)).toBe(before + 1);

  // Play next now: everyone moves to the queued video and the list empties.
  await b.page.locator(site.queueNext).click();
  for (const c of clients) {
    await tvShows(c.page, OTHER_ID);
    await expect(c.page.locator(site.queueRow)).toHaveCount(0);
    await expect(c.page.locator(site.queueNext)).toBeHidden();
  }
});

test("the end of a video advances everyone to the next item; no client reports ended twice", async ({ browser }) => {
  test.setTimeout(90_000);
  const { logs: sent, setup } = sentLogs(3);
  clients = await joinRoom(browser, { roomUrl: testRoom("provider-queue", "ended").url, count: 3, nicknamePrefix: "e", setup });
  const [a] = clients;
  if (a === undefined) throw new Error("need clients");
  await startWith(a.page, WATCH_URL);
  for (const c of clients) await tvShows(c.page, VIDEO_ID);
  const first = await itemId(a.page);
  await paste(a.page, OTHER_URL);
  for (const c of clients) await expect(c.page.locator(site.queueRow)).toHaveCount(1);
  // Let everyone play a moment (the server ignores an end in an item's first 3 s), then seek everyone close to the end.
  await a.page.waitForTimeout(3500);
  await a.page.locator(site.seek).fill("630");
  for (const c of clients) await tvShows(c.page, OTHER_ID);
  for (const c of clients) await expect(c.page.locator(site.queueRow)).toHaveCount(0);
  const second = await itemId(a.page);
  expect(second).not.toBeNull();
  expect(second).not.toBe(first);
  for (const c of clients) expect(await itemId(c.page)).toBe(second);
  // The first report advanced the room; a client whose player hadn't ended yet just moved on. Nobody reported twice,
  // and nobody reported the new item.
  const ended = sent.map((s) => s.filter((m) => m.type === "ended"));
  expect(ended.flat().length).toBeGreaterThan(0);
  for (const e of ended) {
    expect(e.length).toBeLessThanOrEqual(1);
    for (const m of e) expect(m).toMatchObject({ type: "ended", itemId: first });
  }
});

test("a queued generic page stays click-to-load when it becomes current", async ({ browser }) => {
  test.setTimeout(90_000);
  const hits: string[] = [];
  clients = await joinRoom(browser, {
    roomUrl: testRoom("provider-queue", "generic").url,
    count: 2,
    nicknamePrefix: "g",
    setup: async (context) => {
      await context.route(`https://${GENERIC_HOST}/**`, async (route) => {
        hits.push(route.request().url());
        await route.fulfill({ contentType: "text/html", body: "<!doctype html><title>generic</title><p>generic fixture</p>" });
      });
    },
  });
  const [a, b] = clients;
  if (a === undefined || b === undefined) throw new Error("need two clients");
  await startWith(a.page, WATCH_URL);
  for (const c of clients) await tvShows(c.page, VIDEO_ID);
  await paste(a.page, GENERIC_URL);
  for (const c of clients) {
    await expect(c.page.locator(site.queueRow)).toHaveCount(1);
    await expect(c.page.locator(site.queueRow).first()).toContainText("Not synced");
    await expect(c.page.locator(`${site.queueRow} iframe`)).toHaveCount(0);
  }
  await a.page.locator(site.queueNext).click();
  for (const c of clients) {
    await expect(c.page.locator(site.genericCard)).toBeVisible();
    await expect(c.page.locator(site.sharedVideo)).toHaveCount(0);
  }
  await a.page.waitForTimeout(1000);
  expect(hits).toEqual([]);
  // Load is per viewer: a loads it, b still sees the card.
  await a.page.locator(site.genericLoad).click();
  await expect(a.page.locator(site.sharedVideo)).toHaveAttribute("src", GENERIC_URL);
  await expect(b.page.locator(site.genericCard)).toBeVisible();
  await expect(b.page.locator(site.sharedVideo)).toHaveCount(0);
});
