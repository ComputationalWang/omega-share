// Target size (WCAG 2.5.8, OME-1239): the generic strip's Unlock key is at least 24 px tall on a desktop and 44 px to
// a finger, and every name tag the host can pick (Mute / Remove, owner/moderation.ts) catches a 24×24 CSS px square
// around its centre, at 960 and at 390 wide, whatever the stage's fit or the phone window's zoom does to the tag.
import type { Browser, BrowserContextOptions, Page } from "@playwright/test";
import { expect, test, watchCsp } from "./support/csp";
import { PENDING, URLS, available } from "./support/apps";
import { stubExternalNetwork } from "./support/network";
import { joinRoom, leaveAll, testRoom, type Client } from "./support/room";
import { site } from "./support/selectors";
import { ownedRoom } from "./support/owned-rooms";
import { GENERIC_HOST, GENERIC_PAGE, shareProvider } from "../perf/providers";
import { ROOM_SECRETS_STORAGE_KEY } from "@omega/shared";
import { cellCenter } from "../apps/web/src/layout";

test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);

const DESK = { viewport: { width: 960, height: 600 } } as const;
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } as const;

let clients: Client[] = [];
test.afterEach(async () => {
  await leaveAll(clients);
  clients = [];
});

for (const [name, options, min] of [["desk", DESK, 24], ["touch", PHONE, 44]] as const) {
  test(`${name}: the generic strip's Unlock key is at least ${String(min)} px tall`, async ({ browser, request }) => {
    const room = testRoom("targets", name);
    await shareProvider(request, `https://${GENERIC_HOST}/embed/42`, room.id);
    clients = await joinRoom(browser, {
      roomUrl: room.url,
      count: 1,
      nicknamePrefix: `targets-${name}`,
      contextOptions: () => options,
      setup: async (context) => {
        await context.route(`https://${GENERIC_HOST}/**`, (route) => route.fulfill({ contentType: "text/html", body: GENERIC_PAGE }));
      },
    });
    const page = clients[0]?.page;
    if (page === undefined) throw new Error("no client");
    await page.getByTestId("generic-load").click({ timeout: 15_000 });
    // No extension here, so the strip shows the hint: swap in the key it shows with one (as provider-generic does).
    await page.getByTestId("generic-hint").evaluate((hint: HTMLElement) => (hint.hidden = true));
    const unlock = page.getByTestId("generic-strip-unlock");
    await unlock.evaluate((key: HTMLElement) => (key.hidden = false));
    await expect(unlock).toBeVisible();
    const box = await unlock.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(min);
  });
}

/** The points of the 24×24 square centred on each pickable tag that don't land on that tag, per tag. */
function misses(page: Page): Promise<Record<string, string[]>> {
  return page.evaluate(() => {
    const out: Record<string, string[]> = {};
    for (const tag of document.querySelectorAll<HTMLElement>(".tags.pickable [data-member][role=button]")) {
      // Focus pans the phone's room window to the tag (room-window.ts); scrolling brings the page's part.
      tag.focus({ preventScroll: true });
      tag.scrollIntoView({ block: "center", inline: "center" });
      const r = tag.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const missed: string[] = [];
      // Corners 0.5 px inside the square, edge midpoints and the centre.
      for (const dx of [-11.5, 0, 11.5]) {
        for (const dy of [-11.5, 0, 11.5]) {
          // The tag itself, or its hit pad (stage.ts lays one under the tags for it).
          const hit = document.elementFromPoint(cx + dx, cy + dy)?.closest<HTMLElement>("[data-member], [data-pad]");
          if (hit !== tag && hit?.dataset["pad"] !== tag.dataset["member"]) missed.push(`${String(dx)},${String(dy)}: ${hit?.className ?? "nothing"}`);
        }
      }
      out[tag.textContent] = missed;
    }
    return out;
  });
}

async function open(browser: Browser, url: string, nickname: string, options: BrowserContextOptions, secrets?: string): Promise<Page> {
  const context = await watchCsp(await browser.newContext(options));
  if (secrets !== undefined) {
    await context.addInitScript(
      ([origin, key, value]) => {
        if (location.origin === origin && localStorage.getItem(key ?? "") === null) localStorage.setItem(key ?? "", value ?? "");
      },
      [URLS.web, ROOM_SECRETS_STORAGE_KEY, secrets],
    );
  }
  await stubExternalNetwork(context);
  const page = await context.newPage();
  await page.goto(url);
  await page.locator(site.nicknameInput).fill(nickname);
  await page.locator(site.joinButton).click();
  await expect(page.locator(site.room)).toBeVisible();
  clients.push({ context, page, nickname, avatarIndex: 0 });
  return page;
}

test("the host's pickable name tags each catch a 24×24 px square at 960 and at 390 wide", async ({ browser }) => {
  const { id, ownerToken, inviteKey } = ownedRoom("targets");
  const secrets = JSON.stringify({ v: 1, rooms: { [id]: { ownerToken, inviteKey } } });
  const guest = `${URLS.web}/r/${id}#k=${inviteKey}`;
  // Seated in the front row's middle two seats: on the phone the window shows them, and a tag it crops is inert (OME-1325).
  const kit = await open(browser, guest, "kit", DESK);
  const longer = await open(browser, guest, "longer-name", DESK);
  await kit.locator(`${site.seat}[data-seat="5"]`).click();
  await longer.locator(`${site.seat}[data-seat="6"]`).click();
  await expect(kit.locator(`${site.seat}.mine`)).toHaveCount(1);
  await expect(longer.locator(`${site.seat}.mine`)).toHaveCount(1);
  for (const [name, options] of [["960", DESK], ["390", PHONE]] as const) {
    const host = await open(browser, `${URLS.web}/r/${id}`, `host${name}`, options, secrets);
    const pickable = host.locator(`.tags.pickable ${site.nicknameTag}[role=button]`);
    await expect(pickable).toHaveCount(2);
    await expect(host.locator(`${site.nicknameTag}[inert]`)).toHaveCount(0);
    expect(await misses(host), `at ${name} wide`).toEqual({ kit: [], "longer-name": [] });
    await leaveAll(clients.splice(-1));
  }
});

/** Points inside one tag's visible box that another member's hit area takes (it may only lose to a visible tag on top). */
function stolen(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const tags = [...document.querySelectorAll<HTMLElement>(".tags.pickable [data-member][role=button]")];
    const out: string[] = [];
    for (const tag of tags) {
      const r = tag.getBoundingClientRect();
      for (let fx = 0.1; fx < 1; fx += 0.2) {
        for (let fy = 0.1; fy < 1; fy += 0.2) {
          const x = r.left + r.width * fx;
          const y = r.top + r.height * fy;
          const hit = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-member], [data-pad]");
          const who = hit?.dataset["member"] ?? hit?.dataset["pad"];
          if (who === tag.dataset["member"]) continue;
          // Another tag's own box drawn over this one is the art's overlap, not a hit area's.
          const box = hit?.getBoundingClientRect();
          const visible = hit?.dataset["member"] !== undefined && box !== undefined && x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
          if (!visible) out.push(`${tag.textContent} at ${fx.toFixed(1)},${fy.toFixed(1)} → ${hit?.textContent ?? "nothing"}`);
        }
      }
    }
    return out;
  });
}

test("crowded (8 in the room): no tag's hit area takes a click from another tag's visible box", async ({ browser }) => {
  const { id, ownerToken, inviteKey } = ownedRoom("crowd");
  const secrets = JSON.stringify({ v: 1, rooms: { [id]: { ownerToken, inviteKey } } });
  // As perf/moderation.perf.ts has it: the host first, at the default 1280×720, then seven guests.
  const host = await open(browser, `${URLS.web}/r/${id}`, "host", {}, secrets);
  clients.push(...(await joinRoom(browser, { roomUrl: `${URLS.web}/r/${id}#k=${inviteKey}`, count: 7, nicknamePrefix: "md" })));
  await expect(host.locator(`.tags.pickable ${site.nicknameTag}[role=button]`)).toHaveCount(7);
  await host.locator(site.nicknameTag).first().scrollIntoViewIfNeeded();
  // Polled: a tag that just arrived grows in from nothing for a moment.
  await expect.poll(() => stolen(host), { timeout: 10_000 }).toEqual([]);
  // What perf/moderation.perf.ts does: md-1's tag takes the click and opens md-1's menu.
  await host.locator(site.nicknameTag).filter({ hasText: "md-1" }).click({ timeout: 10_000 });
});

/** Cell (x, y)'s centre in page px, wherever the stage is scaled to (as desk-zoom.e2e.ts). */
async function cellOnPage(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  const box = await page.locator(site.walkFloor).evaluate((el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, k: r.width / el.offsetWidth };
  });
  const p = cellCenter(x, y);
  return { x: box.left + p.x * box.k, y: box.top + p.y * box.k };
}

/** Counts style writes to a member's tag and to its hit pad on `page` from now on. */
function countStyleWrites(page: Page, member: string): Promise<void> {
  return page.evaluate((m) => {
    const counts = { tag: 0, pad: 0 };
    Reflect.set(window, "__writes", counts);
    const watch = (sel: string, key: "tag" | "pad"): void => {
      const e = document.querySelector(sel);
      if (e === null) throw new Error(`no ${sel}`);
      new MutationObserver((records) => {
        counts[key] += records.length;
      }).observe(e, { attributeFilter: ["style"] });
    };
    watch(`.tags [data-member="${m}"]`, "tag");
    watch(`.tag-pad[data-pad="${m}"]`, "pad");
  }, member);
}
const styleWrites = (page: Page): Promise<{ tag: number; pad: number }> => page.evaluate(() => Reflect.get(window, "__writes") as { tag: number; pad: number });

// OME-2135: a hit pad shows only on the host's pickable tags. Elsewhere it is `display: none`, so moving it with its tag
// on every frame of a walk was a style recalc per walker per frame for nothing; the host's pads still follow their tags.
test("a walking member's tag moves every frame, its hidden hit pad doesn't; on the host's page the pad follows the tag", async ({ browser }) => {
  const { id, ownerToken, inviteKey } = ownedRoom("tagpads");
  const secrets = JSON.stringify({ v: 1, rooms: { [id]: { ownerToken, inviteKey } } });
  const guest = `${URLS.web}/r/${id}#k=${inviteKey}`;
  const host = await open(browser, `${URLS.web}/r/${id}`, "host", DESK, secrets);
  const watcher = await open(browser, guest, "watcher", DESK);
  const kit = await open(browser, guest, "kit", DESK);
  await expect(host.locator(`.tags.pickable ${site.nicknameTag}[role=button]`)).toHaveCount(2);
  await kit.waitForTimeout(3000); // walked in from the door
  const member = await watcher.locator(site.nicknameTag).filter({ hasText: "kit" }).getAttribute("data-member");
  if (member === null) throw new Error("no kit tag");
  await countStyleWrites(watcher, member);
  // Across the room and back: two walks of several cells each.
  await kit.locator(site.walkFloor).scrollIntoViewIfNeeded();
  for (const [x, y] of [[1, 8], [8, 1]] as const) {
    const p = await cellOnPage(kit, x, y);
    await kit.mouse.click(p.x, p.y);
    await kit.waitForTimeout(3000);
  }
  const writes = await styleWrites(watcher);
  expect(writes.tag, "the tag rode along with the walk").toBeGreaterThan(20);
  // A render (a state change: each `walked`) may still place it; frames don't.
  expect(writes.pad, "the hidden pad stayed put while the tag moved").toBeLessThanOrEqual(4);
  // The host's pickable pad sits where its tag does once the walk is over.
  const at = (sel: string) => host.locator(sel).evaluate((el: HTMLElement) => el.style.translate);
  await expect.poll(async () => (await at(`.tag-pad[data-pad="${member}"]`)) === (await at(`.tags [data-member="${member}"]`))).toBe(true);
});
