// The popup on a phone (OME-743): Firefox for Android opens it as a full-screen sheet 360-412 px wide with a touch pointer.
// Chromium here stands in: the popup page opened as a tab, a viewport of that width, and Blink's pointer/hover switches.
// What every phone has in common is `(hover: none)`. The pointer is not reliable: on Firefox for Android 157 (emulator, the
// OME-743 smoke) a touchscreen that also reports a stylus gives `(pointer: fine)`, and so would an S Pen phone.
// Desktop keeps its fixed 320 px body (Chrome sizes the popup to its content) with a mouse, which hovers.
import type { BrowserContext, Page } from "@playwright/test";
import { PENDING, URLS, available } from "./support/apps";
import { expect, test } from "./support/extension";
import { ownedRoom } from "./support/owned-rooms";
import { site } from "./support/selectors";

test.fixme(!available.extension, PENDING.extension);
test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);

const LONG_HOST = `${"a".repeat(50)}.${"b".repeat(50)}.omega-fixture.org`;
const SHOTS = process.env["OME_743_SHOTS"];
const WIDE_FONT = "* { letter-spacing: 0.15em !important; }";

async function setup(context: BrowserContext, openPopup: (p: Page) => Promise<Page>): Promise<Page> {
  await context.route(`${URLS.fixtures}/long-host.html`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>long</title><iframe src="https://www.youtube.com/embed/aqz-KE-bpKQ"></iframe><iframe src="https://${LONG_HOST}/embed/1"></iframe><iframe src="https://player.twitch.tv/?channel=averyverylongchannelname1&parent=localhost"></iframe>`,
    }),
  );
  const room = ownedRoom("extqempa");
  const member = await context.newPage();
  await member.goto(`${URLS.web}/r/${room.id}#k=${room.inviteKey}`);
  await member.locator(site.nicknameInput).fill("ext-phone");
  await member.locator(site.joinButton).click();
  await expect(member.locator(site.room)).toBeVisible();
  const source = await context.newPage();
  await source.goto(`${URLS.fixtures}/long-host.html`);
  return openPopup(source);
}

// Blink pointer types: 2 coarse, 4 fine; hover types: 1 none.
const PHONES = [
  { name: "a touch phone", pointer: 2 },
  { name: "a phone whose touchscreen reports a stylus (fine pointer, no hover), as Firefox for Android does", pointer: 4 },
] as const;
for (const phone of PHONES) test.describe(phone.name, () => {
  const p = String(phone.pointer);
  test.use({ extraArgs: [`--blink-settings=primaryPointerType=${p},availablePointerTypes=${p},primaryHoverType=1,availableHoverTypes=1`] });
for (const [width, height] of [[360, 740], [412, 915]] as const) {
  test(`the popup fits and is usable at ${String(width)} px on ${phone.name}`, async ({ context, openPopup }) => {
    const popup = await setup(context, openPopup);
    await popup.setViewportSize({ width, height });
    await popup.reload();
    await expect(popup.locator("[data-testid=embed-item]")).toHaveCount(3);
    await expect(popup.locator("[data-testid=share-button]")).toBeVisible();
    // The layout must not depend on the system font's width (OME-862: DejaVu Sans on CI overflowed by 7 px).
    // Letter-spacing stands in for a wide font on any machine.
    await popup.addStyleTag({ content: WIDE_FONT });
    if (SHOTS !== undefined) await popup.screenshot({ path: `${SHOTS}/popup-${p}-${String(width)}.png` });

    expect(await popup.evaluate(() => matchMedia("(hover: none)").matches)).toBe(true);
    // Readable: a viewport meta, so Android lays out at device width instead of 980 px.
    expect.soft(await popup.evaluate(() => document.querySelector("meta[name=viewport]")?.getAttribute("content"))).toBe("width=device-width, initial-scale=1");
    // Fills the sheet, no sideways scroll.
    const m = await popup.evaluate(() => ({ body: document.body.getBoundingClientRect().width, sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    expect.soft(m.body).toBe(width);
    expect.soft(m.sw).toBeLessThanOrEqual(m.cw);

    // Touch targets: at least 44 x 44.
    const targets = ["[data-testid=embed-item] label", "[data-testid=room-select]", "[data-testid=share-button]", "[data-testid=queue-button]", "[data-testid=open-options]"];
    for (const sel of targets) {
      const boxes = await popup.locator(sel).evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { w: r.width, h: r.height }; }));
      expect.soft(boxes.length, sel).toBeGreaterThan(0);
      for (const b of boxes) {
        expect.soft(b.h, `${sel} height`).toBeGreaterThanOrEqual(44);
        expect.soft(b.w, `${sel} width`).toBeGreaterThanOrEqual(44);
      }
    }

    // Focus is visible on every control, tabbing through.
    const seen = new Set<string>();
    for (let i = 0; i < 9; i++) {
      await popup.keyboard.press("Tab");
      const f = await popup.evaluate(() => {
        const e = document.activeElement;
        if (e === null || e === document.body) return null;
        const s = getComputedStyle(e);
        return { id: e.id !== "" ? e.id : (e.getAttribute("name") ?? e.tagName), visible: s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0 && e.matches(":focus-visible") };
      });
      if (f === null) continue;
      seen.add(f.id);
      expect.soft(f.visible, `focus ring on ${f.id}`).toBe(true);
    }
    for (const id of ["room", "share", "queue", "options"]) expect(seen.has(id), id).toBe(true);
  });
}

  // The options page opens as a tab on Android (OME-743 smoke): without a viewport meta it was laid out at 980 px and
  // zoomed out, with a 22 px Save button.
  for (const width of [360, 412] as const) {
    test(`the options page is readable and usable at ${String(width)} px on ${phone.name}`, async ({ context, extensionId }) => {
      const page = await context.newPage();
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`chrome-extension://${extensionId}/options.html`);
      await expect(page.locator("[data-testid=server-url-input]")).toBeVisible();
      expect.soft(await page.evaluate(() => document.querySelector("meta[name=viewport]")?.getAttribute("content"))).toBe("width=device-width, initial-scale=1");
      const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
      expect.soft(m.sw).toBeLessThanOrEqual(m.cw);
      for (const sel of ["[data-testid=server-url-input]", "[data-testid=server-url-save]"]) {
        const b = await page.locator(sel).boundingBox();
        expect.soft(b?.height, `${sel} height`).toBeGreaterThanOrEqual(44);
        expect.soft(b?.width, `${sel} width`).toBeGreaterThanOrEqual(44);
      }
      for (const id of ["url", "save"]) {
        await page.keyboard.press("Tab");
        const f = await page.evaluate(() => {
          const e = document.activeElement;
          const s = e === null ? null : getComputedStyle(e);
          return { id: e?.id, visible: s !== null && s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0 };
        });
        expect.soft(f, `focus ring on ${id}`).toEqual({ id, visible: true });
      }
    });
  }

});

test("on a desktop (a mouse, which hovers) the popup body stays 320 px wide", async ({ context, openPopup }) => {
  const popup = await setup(context, openPopup);
  await popup.setViewportSize({ width: 800, height: 600 });
  await expect(popup.locator("[data-testid=embed-item]")).toHaveCount(3);
  expect(await popup.evaluate(() => matchMedia("(hover: none)").matches)).toBe(false);
  expect(await popup.evaluate(() => document.body.getBoundingClientRect().width)).toBe(320);
  const share = await popup.locator("[data-testid=share-button]").boundingBox();
  expect(share?.height).toBeLessThan(44);
});

// Firefox for Android opens the options page in a tab behind the popup's full-screen sheet, which stays on top, so
// "Server settings" looked dead in the OME-743 smoke. On desktop the popup closes when the tab takes focus; close it ourselves.
test("Server settings opens the options page and closes the popup", async ({ context, openPopup }) => {
  const popup = await setup(context, openPopup);
  await expect(popup.locator("[data-testid=embed-item]")).toHaveCount(3);
  const options = context.waitForEvent("page");
  const closed = popup.waitForEvent("close");
  await popup.locator("[data-testid=open-options]").click();
  // Chrome shows it inside chrome://extensions/?options=<id>; Firefox opens options.html in a tab.
  expect((await options).url()).toMatch(/options/);
  await closed;
  expect(popup.isClosed()).toBe(true);
});
