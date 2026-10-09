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

// ---- Per provider, three clients (OME-510, Q1) ----------------------------------------------------------------------
// One client queues, everyone sees the same rows, a remove propagates, the video's end advances all three to the same
// item, and a manual next moves them on again. Each client reports `ended` at most once per item. Generic items sit
// in a YouTube room: they become current (by the end of the YouTube video, then by next) and stay click-to-load.

const rowIds = (page: Page): Promise<string[]> =>
  page.locator(site.queueRow).evaluateAll((els) => els.map((e) => (e instanceof HTMLElement ? (e.dataset["item"] ?? "") : "")));

/** The shown player's iframe src: the shared-video element itself, or for Twitch's SDK the iframe it builds inside its container. */
const playerSrc = (page: Page): Promise<string> =>
  page.locator(site.sharedVideo).evaluate((el) => (el instanceof HTMLIFrameElement ? el.src : (el.querySelector("iframe")?.src ?? "")));
const playsId = (page: Page, id: string, timeout = 5_000) => expect.poll(() => playerSrc(page), { timeout }).toContain(id);

const ytUrl = (id: string): string => `https://www.youtube.com/watch?v=${id}`;

interface Queued {
  readonly url: string;
  /** What the provider's player URL carries (a generic page has none on its card). */
  readonly id: string;
}

interface QueueCase {
  readonly name: string;
  readonly room: "yt" | "twvod" | "vimeo" | "mixed";
  /** What starts the room. */
  readonly start: Queued;
  /** Queued in order: the first is removed again, the other two play. */
  readonly queued: readonly [Queued, Queued, Queued];
  /** A seek (seconds) close enough to the fake's duration that the video ends within a few seconds. */
  readonly nearEnd: number;
  readonly generic: boolean;
}

const CASES: readonly QueueCase[] = [
  {
    name: "YouTube",
    room: "yt",
    start: { url: WATCH_URL, id: VIDEO_ID },
    queued: [
      { url: OTHER_URL, id: OTHER_ID },
      { url: ytUrl("9bZkp7q19f0"), id: "9bZkp7q19f0" },
      { url: ytUrl("kJQP7kiw5Fk"), id: "kJQP7kiw5Fk" },
    ],
    nearEnd: 630,
    generic: false,
  },
  {
    name: "Twitch VOD",
    room: "twvod",
    start: { url: "https://www.twitch.tv/videos/1234567890", id: "1234567890" },
    queued: [
      { url: "https://www.twitch.tv/videos/1234567891", id: "1234567891" },
      { url: "https://www.twitch.tv/videos/1234567892", id: "1234567892" },
      { url: "https://www.twitch.tv/videos/1234567893", id: "1234567893" },
    ],
    nearEnd: 3595,
    generic: false,
  },
  {
    name: "Vimeo",
    room: "vimeo",
    start: { url: VIMEO_URL, id: "76979871" },
    queued: [
      { url: "https://vimeo.com/76979872", id: "76979872" },
      { url: "https://vimeo.com/76979873", id: "76979873" },
      { url: "https://vimeo.com/76979874", id: "76979874" },
    ],
    nearEnd: 630,
    generic: false,
  },
  {
    name: "generic (queued behind YouTube)",
    room: "mixed",
    start: { url: WATCH_URL, id: VIDEO_ID },
    queued: [
      { url: `https://${GENERIC_HOST}/embed/41`, id: "41" },
      { url: `https://${GENERIC_HOST}/embed/42`, id: "42" },
      { url: `https://${GENERIC_HOST}/embed/43`, id: "43" },
    ],
    nearEnd: 630,
    generic: true,
  },
];

for (const c of CASES) {
  test(`${c.name}: three clients see the same queue, a remove reaches all, the end and next move all three to the same item, ended at most once each`, async ({ browser }) => {
    test.setTimeout(120_000);
    const hits: string[] = [];
    const { logs: sent, setup: record } = sentLogs(3);
    clients = await joinRoom(browser, {
      roomUrl: testRoom("provider-queue", c.room).url,
      count: 3,
      nicknamePrefix: `q${c.room}`,
      setup: async (context, i) => {
        await record(context, i);
        await context.route(`https://${GENERIC_HOST}/**`, async (route) => {
          hits.push(route.request().url());
          await route.fulfill({ contentType: "text/html", body: "<!doctype html><title>generic</title><p>generic fixture</p>" });
        });
      },
    });
    const [a, b, d] = clients;
    if (a === undefined || b === undefined || d === undefined) throw new Error("need three clients");
    const [n1, n2, n3] = c.queued;

    // Everyone is on the starting video.
    await startWith(a.page, c.start.url);
    for (const k of clients) await playsId(k.page, c.start.id);
    const first = await itemId(a.page);
    expect(first).not.toBeNull();
    for (const k of clients) expect(await itemId(k.page)).toBe(first);

    // a queues two, b a third: all three see the same three rows, in order.
    await paste(a.page, n1.url);
    await expect(a.page.locator(site.queueRow)).toHaveCount(1);
    await paste(a.page, n2.url);
    await expect(a.page.locator(site.queueRow)).toHaveCount(2);
    await paste(b.page, n3.url);
    for (const k of clients) {
      await expect(k.page.locator(site.queueRow)).toHaveCount(3);
      await expect(k.page.locator(site.queueCount)).toHaveText("3 / 20");
    }
    const all = await rowIds(a.page);
    expect(new Set(all).size).toBe(3);
    for (const k of [b, d]) expect(await rowIds(k.page)).toEqual(all);
    if (c.generic) for (const k of clients) await expect(k.page.locator(site.queueRow).first()).toContainText("Not synced");

    // a removes the head row: all three drop exactly that one, and the next row is now the head.
    await a.page.locator(`${site.queueRow}:nth-child(1) ${site.queueRemove}`).click();
    for (const k of clients) {
      await expect(k.page.locator(site.queueRow)).toHaveCount(2);
      await expect(k.page.locator(site.queueCount)).toHaveText("2 / 20");
    }
    const [, id2, id3] = all;
    for (const k of clients) expect(await rowIds(k.page)).toEqual([id2, id3]);

    const shows = async (q: Queued): Promise<void> => {
      for (const k of clients) {
        if (c.generic) {
          await expect(k.page.locator(site.genericCard)).toBeVisible({ timeout: 20_000 });
          await expect(k.page.locator(site.sharedVideo)).toHaveCount(0);
        } else {
          await playsId(k.page, q.id, 20_000);
        }
      }
    };
    // The end of the video: let everyone play past the server's 3 s debounce, then seek close to the end.
    await a.page.waitForTimeout(3500);
    await a.page.locator(site.seek).fill(String(c.nearEnd));
    await shows(n2);
    for (const k of clients) await expect(k.page.locator(site.queueRow)).toHaveCount(1, { timeout: 20_000 });
    const second = await itemId(a.page);
    expect(second).not.toBe(first);
    for (const k of clients) {
      expect(await itemId(k.page)).toBe(second);
      expect(await rowIds(k.page)).toEqual([id3]);
    }

    // Next now: all three on the last item, the list empty.
    await d.page.locator(site.queueNext).click();
    for (const k of clients) {
      await expect(k.page.locator(site.queueRow)).toHaveCount(0);
      await expect(k.page.locator(site.queueNext)).toBeHidden();
    }
    await shows(n3);
    const third = await itemId(a.page);
    expect(third).not.toBe(second);
    for (const k of clients) expect(await itemId(k.page)).toBe(third);

    // Ended: the first report advanced the room (a client may have moved on before its own player ended); no client
    // reported the same item twice, and none reported an item that wasn't current when it did.
    const ended = sent.map((s) => s.filter((m) => m.type === "ended"));
    for (const e of ended) {
      const ids = e.map((m) => m["itemId"]);
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) expect([first, second]).toContain(id);
    }
    if (!c.generic) expect(ended.flat().length).toBeGreaterThan(0);
    if (c.generic) {
      // Generic items stay click-to-load through both advances: nothing fetched, nothing loaded, on every viewer.
      await a.page.waitForTimeout(1000);
      expect(hits).toEqual([]);
      for (const k of clients) await expect(k.page.locator(site.sharedVideo)).toHaveCount(0);
    }
  });
}
