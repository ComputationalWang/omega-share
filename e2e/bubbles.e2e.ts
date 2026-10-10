// Floating chat bubbles (OME-730, M8 W1, set l): a message floats over its speaker from a fixed pool of 8 DOM nodes in
// an aria-hidden layer (the chat log is the accessible record), costs the room no canvas render, never overlaps
// another bubble, and keeps at most 2 per speaker. Pool reuse, stacking maths and the per-event rule are unit tests
// (apps/web/test/floats.test.ts); the frame budgets with a chat burst are perf/chat.perf.ts and its siblings.
import type { Page } from "@playwright/test";
import * as v from "valibot";
import { expect, test } from "./support/csp";
import { PENDING, available } from "./support/apps";
import { clickClosing, joinRoom, leaveAll, testRoom, type Client } from "./support/room";
import { site } from "./support/selectors";

test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);

let clients: Client[] = [];
test.afterEach(async () => {
  await leaveAll(clients);
  clients = [];
});

async function say(page: Page, text: string): Promise<void> {
  await page.locator(site.chatInput).fill(text);
  await page.locator(site.chatInput).press("Enter");
}

/** The dev handle (apps/web/src/main.ts `window.__omega.room`): how many times the room canvas has rendered. */
async function roomRenders(page: Page): Promise<number> {
  const n = await page.evaluate(() => {
    const debug: unknown = Reflect.get(window, "__omega");
    const room: unknown = typeof debug === "object" && debug !== null ? Reflect.get(debug, "room") : null;
    const f: unknown = typeof room === "object" && room !== null ? Reflect.get(room, "roomRenders") : null;
    return typeof f === "function" ? (Reflect.apply(f, room, []) as unknown) : null;
  });
  return v.parse(v.number(), n);
}

/** Waits until the canvas has drawn nothing for a whole second (joins, walks and the motion sheet are done). */
async function settledRenders(page: Page): Promise<number> {
  let last = await roomRenders(page);
  await expect
    .poll(
      async () => {
        await page.waitForTimeout(1000);
        const now = await roomRenders(page);
        const still = now === last;
        last = now;
        return still;
      },
      { timeout: 20_000, intervals: [0] },
    )
    .toBe(true);
  return last;
}

test("the layer is aria-hidden with no live region, holds 8 nodes, and a bubble costs the room no render", async ({ browser }) => {
  // Reduced motion: an avatar at rest doesn't breathe, so any render after the room settles would be the bubble's.
  clients = await joinRoom(browser, { roomUrl: testRoom("bubbles", "renders").url, count: 2, nicknamePrefix: "br", contextOptions: () => ({ reducedMotion: "reduce" }) });
  const [a, b] = clients;
  if (a === undefined || b === undefined) throw new Error("no clients");
  const layer = a.page.locator(`${site.room} .bubbles`);
  await expect(layer).toHaveAttribute("aria-hidden", "true");
  await expect(layer).not.toHaveAttribute("aria-live", /.*/);
  await expect(layer.locator(".float-slot")).toHaveCount(8);
  await expect(a.page.locator(site.chatLog)).toHaveAttribute("aria-live", "polite");
  await expect(a.page.locator(`${site.room} [role=log], ${site.room} [aria-live]`)).toHaveCount(1); // only the sysline rail

  const before = await settledRenders(a.page);
  await say(b.page, "first bubble");
  await say(a.page, "my own bubble");
  await expect(a.page.locator(site.chatMessage)).toHaveText(["first bubble", "my own bubble"], { useInnerText: true });
  await expect(a.page.locator(".ui-float.is-self")).toHaveCount(1);
  await a.page.waitForTimeout(1000);
  expect(await roomRenders(a.page)).toBe(before);
  await expect(layer.locator(".float-slot")).toHaveCount(8);
});

test("two bubbles from one speaker never overlap: the older one moves up, 3 px clear, and names its speaker", async ({ browser }) => {
  clients = await joinRoom(browser, { roomUrl: testRoom("bubbles", "stack").url, count: 1, nicknamePrefix: "bs" });
  const [a] = clients;
  if (a === undefined) throw new Error("no client");
  await say(a.page, "older line");
  await say(a.page, "newer line");
  const older = a.page.locator(".ui-float").filter({ hasText: "older line" });
  const newer = a.page.locator(".ui-float").filter({ hasText: "newer line" });
  await expect(older).toHaveClass(/is-stacked/);
  await expect(older.locator(".who")).toHaveText("bs-1");
  await expect(newer).not.toHaveClass(/is-stacked/);
  // The push slides in 160 ms; after it, the gap holds through the whole rise (stage px: the stage is scaled to fit).
  const stage = await a.page.locator(site.room).boundingBox();
  if (stage === null) throw new Error("no stage");
  const scale = stage.width / 960;
  await a.page.waitForTimeout(400);
  for (let i = 0; i < 3; i++) {
    const o = await older.boundingBox();
    const n = await newer.boundingBox();
    if (o === null || n === null) throw new Error("bubble not laid out");
    expect((n.y - (o.y + o.height)) / scale).toBeGreaterThanOrEqual(3 - 0.5);
    await a.page.waitForTimeout(700);
  }
});

test("2 per speaker: a third line sends the oldest away; the bubbles fade out after about 5 s", async ({ browser }) => {
  clients = await joinRoom(browser, { roomUrl: testRoom("bubbles", "caps").url, count: 1, nicknamePrefix: "bc" });
  const [a] = clients;
  if (a === undefined) throw new Error("no client");
  await say(a.page, "one");
  await say(a.page, "two");
  await say(a.page, "three");
  await expect(a.page.locator(site.chatMessage)).toHaveText(["two", "three"], { useInnerText: true });
  await expect(a.page.locator(site.chatMessage)).toHaveCount(0, { timeout: 7000 });
  await expect(a.page.locator(`${site.room} .float-slot`)).toHaveCount(8);
});

/** The bubble's box against where it should hang: centred on the head (left = -width/2), the tail straight down. */
async function expectCentred(page: Page, text: string): Promise<void> {
  const p = page.locator(".ui-float").filter({ hasText: text });
  await expect(p).toBeVisible();
  const box = await p.evaluate((e) => ({ left: parseFloat((e as HTMLElement).style.left), w: (e as HTMLElement).offsetWidth, cls: e.getAttribute("class") ?? "" }));
  expect(box.w).toBeGreaterThan(0);
  expect(Math.abs(box.left + box.w / 2)).toBeLessThanOrEqual(1);
  expect(box.cls).not.toMatch(/tail-sw|tail-se/);
}

test("a line said while I'm in full screen hangs over the speaker's head once I leave it (QA OME-736 F1)", async ({ browser }) => {
  clients = await joinRoom(browser, { roomUrl: testRoom("bubbles", "fs").url, count: 2, nicknamePrefix: "bf" });
  const [a, b] = clients;
  if (a === undefined || b === undefined) throw new Error("no clients");
  await a.page.locator(site.fullscreenToggle).click();
  await expect.poll(() => a.page.evaluate(() => document.fullscreenElement !== null)).toBe(true);
  await say(b.page, "said in full screen");
  await expect(a.page.locator(site.fsStrip).locator(site.chatLogLine).last()).toContainText("said in full screen");
  await a.page.evaluate(() => document.exitFullscreen());
  await expect.poll(() => a.page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  await expectCentred(a.page, "said in full screen");
});

test("a line said while the room is popped out hangs over the speaker's head once the room comes back", async ({ browser }) => {
  clients = await joinRoom(browser, { roomUrl: testRoom("bubbles", "popin").url, count: 2, nicknamePrefix: "bp" });
  const [a, b] = clients;
  if (a === undefined || b === undefined) throw new Error("no clients");
  const [pop] = await Promise.all([a.context.waitForEvent("page"), a.page.locator(site.roomPopout).click()]);
  await pop.waitForLoadState();
  await expect(a.page.locator(site.roomAway)).toBeVisible();
  await say(b.page, "said while popped out");
  await expect(pop.locator(site.chatMessage)).toHaveText(["said while popped out"], { useInnerText: true });
  await clickClosing(pop, pop.locator(site.popoutBack));
  await expect(a.page.locator(site.roomAway)).toBeHidden();
  await expectCentred(a.page, "said while popped out");
});
