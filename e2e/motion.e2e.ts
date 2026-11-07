// Motion, press states and reduced motion (OME-2308, docs/design/site-redesign-2/HANDOFF.md "Motion"): atlas keys swap
// to their -press slice at once, content enters by opacity + transform only, and reduced motion runs no animation at all.
import type { Page } from "@playwright/test";
import { expect, test } from "./support/csp";
import { PENDING, available } from "./support/apps";
import { joinRoom, leaveAll, testRoom, type Client } from "./support/room";
import { site } from "./support/selectors";
import { watchCsp } from "./support/csp";
import { stubExternalNetwork } from "./support/network";

test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);
let clients: Client[] = [];
test.afterEach(async () => {
  await leaveAll(clients);
  clients = [];
});

/** Every element.animate() call, kept from the first script on: what it moved and for how long. */
const RECORD = `(() => {
  const calls = [];
  window.__motion = calls;
  const animate = Element.prototype.animate;
  Element.prototype.animate = function (frames, options) {
    const props = new Set();
    for (const f of Array.isArray(frames) ? frames : [frames]) for (const k of Object.keys(f)) if (!["offset", "easing", "composite"].includes(k)) props.add(k);
    const duration = typeof options === "number" ? options : (options && typeof options.duration === "number" ? options.duration : 0);
    calls.push({ testId: this.getAttribute("data-testid"), className: String(this.className), props: [...props], duration });
    return animate.call(this, frames, options);
  };
})();`;

interface Call { readonly testId: string | null; readonly className: string; readonly props: readonly string[]; readonly duration: number }
const calls = (page: Page): Promise<Call[]> => page.evaluate(() => (globalThis as unknown as { __motion: Call[] }).__motion);

/** Properties that never move layout: the only ones a transition, a CSS animation or a Web Animation may touch. */
const PAINT_ONLY = ["opacity", "transform", "translate", "background-color", "box-shadow", "color", "visibility", "filter", "border-image-source"];

/** Every running transition (non-zero duration) and animation keyframe on the page that touches a layout property. */
function layoutMotion(page: Page): Promise<string[]> {
  return page.evaluate((allowed) => {
    const out: string[] = [];
    for (const e of document.querySelectorAll("*")) {
      const cs = getComputedStyle(e);
      const props = cs.transitionProperty.split(",").map((s) => s.trim());
      const durations = cs.transitionDuration.split(",").map((s) => parseFloat(s));
      props.forEach((p, i) => {
        const d = durations[i % durations.length] ?? 0;
        if (d > 0 && !allowed.includes(p)) out.push(`${e.tagName.toLowerCase()}.${String(e.className)} transitions ${p}`);
      });
    }
    for (const a of document.getAnimations()) {
      const frames = a.effect instanceof KeyframeEffect ? a.effect.getKeyframes() : [];
      for (const f of frames) for (const k of Object.keys(f)) {
        if (["offset", "computedOffset", "easing", "composite"].includes(k)) continue;
        const css = k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
        if (!allowed.includes(css)) out.push(`animation ${a.id || a.constructor.name} moves ${css}`);
      }
    }
    return out;
  }, PAINT_ONLY);
}

const borderImage = (page: Page, selector: string): Promise<string> => page.locator(selector).first().evaluate((e) => getComputedStyle(e).borderImageSource);

test("Enter shows its press slice on pointerdown, at 0 ms, and keeps it while the room opens", async ({ browser }) => {
  const room = testRoom("motion", "enter");
  const context = await watchCsp(await browser.newContext({ viewport: { width: 1280, height: 800 } }));
  await stubExternalNetwork(context);
  const page = await context.newPage();
  await page.addInitScript(RECORD);
  await page.goto(room.url);
  await page.locator(site.nicknameInput).fill("presser");
  await page.locator(site.avatarOption).first().click();
  const enter = page.locator(site.joinButton);
  await enter.hover();
  expect(await borderImage(page, site.joinButton)).toContain("-hover");
  expect(await enter.evaluate((e) => getComputedStyle(e).transitionDuration.split(",").every((d) => parseFloat(d) === 0))).toBe(true);
  await page.mouse.down();
  expect(await borderImage(page, site.joinButton)).toContain("-press");
  await page.mouse.up();
  await expect(enter).toHaveText("Opening the room…");
  expect(await borderImage(page, site.joinButton)).toContain("-press");
  await page.locator(site.room).waitFor();
  // The scene fades in under the bar and the transport: opacity alone, 160 ms.
  expect(await calls(page)).toContainEqual({ testId: "room", className: expect.any(String), props: ["opacity"], duration: 160 });
  await context.close();
});

test("a room key shows -press on pointerdown; tab content enters by opacity + transform in 140 ms; nothing animates layout", async ({ browser }) => {
  const room = testRoom("motion", "desk");
  clients = await joinRoom(browser, { roomUrl: room.url, count: 1, nicknamePrefix: "motion",
    contextOptions: () => ({ viewport: { width: 1280, height: 800 } }), setup: (c) => c.addInitScript(RECORD) });
  const page = clients[0]?.page;
  if (page === undefined) throw new Error("No client");
  await page.locator(site.helpKey).hover();
  await page.mouse.down();
  expect(await borderImage(page, site.helpKey)).toContain("-press");
  await page.mouse.move(0, 0);
  await page.mouse.up();
  const underline = page.locator(".panel-tabs > .tab-underline");
  const before = await underline.evaluate((e) => e.getBoundingClientRect().x);
  await page.getByRole("tab", { name: "Up next", exact: true }).click();
  expect((await calls(page)).filter((c) => c.className.includes("panel-body"))).toEqual([{ testId: null, className: expect.stringContaining("panel-queue"), props: ["opacity", "transform"], duration: 140 }]);
  expect(await underline.evaluate((e) => getComputedStyle(e).transition)).toContain("transform 0.14s");
  expect(await layoutMotion(page)).toEqual([]);
  await expect.poll(() => underline.evaluate((e) => e.getBoundingClientRect().x)).toBeGreaterThan(before);
  for (const c of await calls(page)) {
    expect(c.props.every((p) => ["opacity", "transform"].includes(p)), `${c.className}: ${c.props.join()}`).toBe(true);
    expect(c.duration).toBeLessThanOrEqual(200);
  }
});

test("reduced motion: no Web Animation runs, the underline sits without a transform, and turning it on cancels a running one", async ({ browser }) => {
  const room = testRoom("motion", "reduced");
  clients = await joinRoom(browser, { roomUrl: room.url, count: 1, nicknamePrefix: "still",
    contextOptions: () => ({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }), setup: (c) => c.addInitScript(RECORD) });
  const page = clients[0]?.page;
  if (page === undefined) throw new Error("No client");
  const running = (): Promise<number> => page.evaluate(() => document.getAnimations().filter((a) => !(a instanceof CSSAnimation) && !(a instanceof CSSTransition) && a.playState === "running").length);
  // Motion on: a tab switch starts the panel's entrance (and the sheet's slide); reduced motion arriving cancels them.
  await page.getByRole("tab", { name: "Room", exact: true }).click();
  expect(await running()).toBeGreaterThan(0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await running()).toBe(0);
  const n = (await calls(page)).length;
  await page.getByRole("tab", { name: "Up next", exact: true }).click();
  await page.getByRole("tab", { name: "Chat", exact: true }).click();
  expect((await calls(page)).length).toBe(n);
  expect(await running()).toBe(0);
  const underline = page.locator(".panel-tabs > .tab-underline");
  expect(await underline.evaluate((e) => [getComputedStyle(e).transform, getComputedStyle(e).transitionDuration])).toEqual(["none", "0s"]);
  expect(await layoutMotion(page)).toEqual([]);
});
