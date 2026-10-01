// Generic tier through the extension (OME-294, ADR 0024): a local fixture page embeds a video from a host we don't
// sync; the popup lists it as "not synced" and shares it into the lobby. In the room, a click-to-load card comes
// first and nothing reaches that host before Load; after Load there is exactly one iframe with the ADR's fixed
// attributes, and the embed (hostile here) can't navigate the room or open popups, by script or by a clicked link.
// The host is never on the real network: the spec's routes serve it. Runs in `e2e-sync` (provider-*): it replaces the lobby's video.
import type { Page, Request } from "@playwright/test";
import { DEFAULT_ROOM_ID } from "@omega/shared";
import { expect, test } from "./support/extension";
import { PENDING, URLS, available } from "./support/apps";
import { gotoFixture } from "./support/network";
import { popup, site } from "./support/selectors";

const ROOM_URL = `${URLS.web}/r/${DEFAULT_ROOM_ID}`;
const HOST = "video.omega-fixture.org";
const EMBED_URL = `https://${HOST}/embed/42`;
const EVIL = "evil.omega-fixture.org";

// The embed as the room's iframe gets it: it tries every way out of the frame and writes down what happened.
const HOSTILE = `<!doctype html><title>hostile embed</title>
<p id="ready">generic fixture</p>
<a id="top-link" href="https://${EVIL}/link-top" target="_top">top</a>
<a id="popup-link" href="https://${EVIL}/link-popup" target="_blank">popup</a>
<ul id="log"></ul>
<button id="escape">escape</button>
<script>
  const log = (k, v) => { const li = document.createElement("li"); li.dataset.k = k; li.textContent = v; document.getElementById("log").append(li); };
  const attempt = (k, f) => { try { log(k, String(f())); } catch (e) { log(k, "threw " + e.name); } };
  // Run on a click, so each attempt has a user activation: without the sandbox, a cross-origin frame may then
  // navigate the top page and open a popup, so only the sandbox can stop these.
  document.getElementById("escape").addEventListener("click", () => {
    attempt("open", () => (window.open("https://${EVIL}/script-popup") === null ? "null" : "window"));
    attempt("top-href", () => { top.location.href = "https://${EVIL}/script-top"; return "no throw"; });
    log("done", "yes");
  });
</script>`;

/** Requests to `host` made by `page` (or its frames), from Playwright's request events: the network capture. */
function captureHost(page: Page, host: string): string[] {
  const hits: string[] = [];
  page.on("request", (r: Request) => {
    if (new URL(r.url()).hostname === host) hits.push(r.url());
  });
  return hits;
}

test.describe("generic embed shared from the extension → click-to-load in the room", () => {
  test.fixme(!available.web, PENDING.web);
  test.fixme(!available.server, PENDING.server);
  test.fixme(!available.extension, PENDING.extension);

  test("listed as not synced, shared, nothing loads before Load, then one fixed sandboxed frame that can't escape", async ({ context, openPopup }, info) => {
    test.setTimeout(120_000);
    // Later routes win over the network stub. Every request to either fixture host lands here too.
    const routed: string[] = [];
    await context.route(`https://${HOST}/**`, async (route) => {
      routed.push(route.request().url());
      await route.fulfill({ contentType: "text/html", body: HOSTILE });
    });
    const evil: string[] = [];
    await context.route(`https://${EVIL}/**`, async (route) => {
      evil.push(route.request().url());
      await route.fulfill({ contentType: "text/html", body: "<!doctype html><title>escaped</title>" });
    });

    // The popup reads the share token from an open room tab of the site (OME-130/OME-142).
    const room = await context.newPage();
    const roomHits = captureHost(room, HOST);
    await room.goto(ROOM_URL);
    await room.locator(site.nicknameInput).fill("generic-share");
    await room.locator(site.avatarOption).first().click();
    await room.locator(site.joinButton).click();
    await expect(room.locator(site.room)).toBeVisible();

    // The source page's own copy of the embed is a plain page: the hostile one is only for the room's frame.
    const source = await context.newPage();
    await source.route(`https://${HOST}/**`, (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><p>source copy</p>" }));
    await gotoFixture(source, "generic-embed");
    const routedBeforeShare = routed.length;

    await expect
      .poll(async () => {
        const p = await openPopup(source);
        const item = p.locator(`${popup.embedItem}[data-provider="generic"]`);
        await expect(item).toHaveCount(1);
        await expect(item).toContainText(HOST);
        await expect(item).toContainText(/not synced/i);
        await item.locator(`input[name=embed][value="${EMBED_URL}"]`).check();
        await p.locator(popup.shareButton).click();
        await expect(p.locator(popup.shareStatus)).toBeVisible();
        const state = await p.locator(popup.shareStatus).getAttribute("data-state");
        if (state === "ok") await info.attach("popup-generic", { body: await p.screenshot(), contentType: "image/png" });
        await p.close();
        return state;
      }, { timeout: 30_000, intervals: [3_000] })
      .toBe("ok");

    const card = room.getByTestId("generic-card");
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toContainText(`Video from ${HOST}`);
    await expect(card).toContainText(/not synced/i);
    await expect(room.getByTestId("not-synced")).toBeVisible();
    await expect(room.locator("iframe")).toHaveCount(0);
    // Give a stray favicon, preconnect or prefetch time to show up.
    await room.waitForTimeout(1_000);
    expect(roomHits).toEqual([]);
    expect(routed.length).toBe(routedBeforeShare);
    const resources = await room.evaluate((h) => performance.getEntriesByType("resource").map((e) => e.name).filter((n) => n.includes(h)), HOST);
    expect(resources).toEqual([]);
    // Resource hints never show as requests: none may name the host either (ADR 0024 §3).
    const hints = await room.evaluate((h) => [...document.querySelectorAll("link")].filter((l) => l.href.includes(h)).map((l) => l.outerHTML), HOST);
    expect(hints).toEqual([]);
    await info.attach("room-card-before-load", { body: await room.screenshot(), contentType: "image/png" });

    await room.getByTestId("generic-load").click();
    const frame = room.locator(site.sharedVideo);
    await expect(frame).toHaveCount(1);
    await expect(room.locator("iframe")).toHaveCount(1);
    const attrs = await frame.evaluate((f) => Object.fromEntries([...f.attributes].map((a) => [a.name, a.value])));
    expect(attrs).toMatchObject({
      src: EMBED_URL,
      sandbox: "allow-scripts allow-same-origin allow-presentation",
      allow: "fullscreen; autoplay",
      referrerpolicy: "no-referrer",
    });
    expect(Object.keys(attrs).sort()).toEqual(["allow", "data-testid", "referrerpolicy", "sandbox", "src", "title"]);
    expect(roomHits).toEqual([EMBED_URL]);

    // The hostile embed tries every way out, each with a real user activation inside the frame: script, then links.
    const inner = room.frameLocator(site.sharedVideo);
    await expect(inner.locator("#ready")).toHaveText("generic fixture");
    const pagesBefore = context.pages().length;
    await inner.locator("#escape").click();
    await expect(inner.locator('[data-k="done"]')).toHaveText("yes");
    await inner.locator("#top-link").click();
    await inner.locator("#popup-link").click();
    // Navigations and popups start asynchronously: give a successful escape time to show.
    await room.waitForTimeout(1_000);
    const log = await inner.locator("#log li").evaluateAll((lis) => lis.map((li) => [li.getAttribute("data-k"), li.textContent]));
    await info.attach("hostile-embed-log.json", { body: JSON.stringify(log, null, 2), contentType: "application/json" });

    expect(room.url()).toBe(ROOM_URL);
    await expect(room.locator(site.room)).toBeVisible();
    expect(context.pages().length).toBe(pagesBefore);
    expect(evil).toEqual([]);
    // window.open is refused (null) by the sandbox even with a user activation.
    expect(Object.fromEntries(log)).toMatchObject({ open: "null" });
    // The frame itself is still the embed: a blocked top navigation must not have navigated it either.
    await expect(inner.locator("#ready")).toHaveText("generic fixture");
    await expect(room.getByTestId("not-synced")).toBeVisible();
    await info.attach("room-after-load", { body: await room.screenshot(), contentType: "image/png" });
  });
});
