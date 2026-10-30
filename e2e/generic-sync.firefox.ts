import type { Frame, Page } from "puppeteer-core";
import { URLS } from "./support/apps";
import { expect, test } from "./support/csp";
import { type FirefoxExtension, OPEN_POPUP_HASH, launchFirefoxWithExtension } from "./support/firefox";

// ADR 0057 §3/§5 in Firefox: the room page attaches to the unlocked host's frame and drives its <video>. The harness
// serves the host over plain http, and the relay takes frame reports only from https://<host>, so this reads the
// video itself; the frame-state path is covered in Chromium (e2e/provider-generic-sync.e2e.ts).
const XFO_HOST = "xfo.omega-fixture.net";
const ROOM = `${URLS.fixtures}/unlock-room.html?page=video`;

test.describe("Firefox generic frame sync", () => {
  test.setTimeout(90_000);
  let ff: FirefoxExtension;
  test.beforeAll(async () => {
    ff = await launchFirefoxWithExtension({ "network.dns.localDomains": XFO_HOST });
  });
  test.afterAll(async () => {
    await ff.browser.close();
  });

  const hostFrame = (page: Page): Frame | undefined => page.frames().find((f) => f.url().includes(`${XFO_HOST}:`));
  /** "playing 3.2" / "paused 20", read from the frame's own <video>. */
  const state = async (page: Page): Promise<string> =>
    (await hostFrame(page)?.$eval("video", (v) => `${v.paused ? "paused" : "playing"} ${String(v.currentTime)}`)) ?? "";
  const position = async (page: Page) => Number((await state(page)).split(" ")[1]);

  /** Room page with the extension pointed at our origin, the host unlocked and the video page loaded (attach is posted on its load). */
  async function loadedRoom(): Promise<Page> {
    const page = await ff.browser.newPage();
    await page.goto(ROOM);
    await page.evaluate((h) => {
      location.hash = h;
    }, `${OPEN_POPUP_HASH}=${encodeURIComponent(URLS.fixtures)}`);
    await expect.poll(async () => {
      await page.goto(ROOM);
      return page.$eval("#present", (el) => el.textContent);
    }).toMatch(/^present \d/);
    await page.click("#unlock");
    await page.waitForFunction((t) => document.querySelector("#result")?.textContent === t, {}, `${XFO_HOST} unlocked`);
    await page.click("#load");
    await expect.poll(() => state(page)).toBe("paused 0");
    return page;
  }

  test("attach, play, pause and seek drive the frame's video", async () => {
    const page = await loadedRoom();
    const seen: (string | null)[] = [];

    await page.click("#cmd-play");
    await expect.poll(() => state(page), { timeout: 15_000 }).toMatch(/^playing /);
    const start = await position(page);
    await expect.poll(() => position(page)).toBeGreaterThan(start + 0.5);
    seen.push(await state(page));

    await page.click("#cmd-pause");
    await expect.poll(() => state(page)).toMatch(/^paused /);
    seen.push(await state(page));

    await page.click("#cmd-seek");
    await expect.poll(() => position(page)).toBeGreaterThan(19.5);
    expect(await position(page)).toBeLessThan(21);
    seen.push(await state(page));
    console.log(`frame-states: ${seen.join(" | ")}; ${await ff.browser.version()}`);
  });

  test("a frame-command for a different host does nothing", async () => {
    const page = await loadedRoom();
    await page.click("#cmd-other");
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(await state(page)).toBe("paused 0");
  });
});
