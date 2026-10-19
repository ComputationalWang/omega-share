// OME-1326: the a11y and viewport regression gate (docs/qa/a11y-sweep.md), promoted from the OME-1300/OME-1324 sweep.
// Every surface below, at each of 4 viewports (1280×800, 390×844 touch, 844×390 touch, 320×640), plus the
// extension's popup, options and consent pages, must have:
//  - no serious or critical axe violation (wcag2a/2aa/21a/21aa/22aa, iframes excluded, border-image contrast judged by
//    `paintedContrast`). axe's `target-size` (WCAG 2.5.8, spacing-aware) is in wcag22aa, so it runs everywhere;
//  - no horizontal overflow (`scrollWidth > innerWidth`);
//  - no focusable control off-screen or clipped by an ancestor (inside a scroller is fine: it scrolls into view);
//  - under `.ui-touch`, every control at least 44 px each way, counting a `::before` hit area (CEO, OME-1326).
// The tests of this file stay in one worker (no fullyParallel) and each viewport uses rooms of its own.
import AxeBuilder from "@axe-core/playwright";
import type { Browser, BrowserContext, BrowserContextOptions, Page } from "@playwright/test";
import { ROOM_SECRETS_STORAGE_KEY } from "@omega/shared";
import { expect, watchCsp } from "./support/csp";
import { test } from "./support/extension";
import { PENDING, URLS, available } from "./support/apps";
import { gotoFixture, stubExternalNetwork } from "./support/network";
import { site } from "./support/selectors";
import { ownedRoom, type OwnedRoomName } from "./support/owned-rooms";
import { testRoom } from "./support/room";
import { openDirectory } from "./support/directory";
import { paintedContrast } from "./support/painted-contrast";

test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);
test.setTimeout(120_000);
const id = (name: string): string => `[data-testid="${name}"]`;

interface VP { name: string; opts: BrowserContextOptions }
const touch = (width: number, height: number): BrowserContextOptions => ({ viewport: { width, height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const VIEWPORTS: VP[] = [
  { name: "1280x800", opts: { viewport: { width: 1280, height: 800 } } },
  { name: "390x844-touch", opts: touch(390, 844) },
  { name: "844x390-touch", opts: touch(844, 390) },
  { name: "320x640", opts: { viewport: { width: 320, height: 640 } } },
];
const ROOMS = ["w1280", "p390", "l844", "n320"] as const;
const OWNED: OwnedRoomName[] = ["sweepa", "sweepb", "sweepc", "sweepd"];

/** Serious/critical axe violations, with border-image contrast re-judged by `paintedContrast`. */
async function axe(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).exclude("iframe").analyze();
  const out: string[] = [];
  for (const v of result.violations.filter((x) => x.impact === "serious" || x.impact === "critical")) {
    for (const n of v.nodes) {
      const [selector] = n.target;
      if (v.id !== "color-contrast" || typeof selector !== "string") {
        out.push(`${v.id} (${v.impact ?? "?"}) ${n.target.join(" ")} :: ${n.failureSummary?.replace(/\s+/g, " ").slice(0, 220) ?? v.help}`);
        continue;
      }
      const painted = await paintedContrast(page, selector);
      // No painted background: a plain CSS one, so axe's own verdict stands.
      if (painted.some((r) => r.includes("no painted background"))) out.push(`color-contrast (serious) ${selector} :: ${n.any.map((c) => c.message).join(" / ")}`);
      else out.push(...painted.map((r) => `color-contrast (painted) ${r}`));
    }
  }
  return out;
}

/** Overflow, focusable controls off-screen or clipped by an ancestor, and the 44 px floor under `.ui-touch`. */
const measure = (page: Page): Promise<string[]> =>
  page.evaluate(async () => {
    const W = window.innerWidth;
    const describe = (el: Element): string => {
      const t = el.getAttribute("data-testid");
      const cls = typeof el.className === "string" && el.className.trim() !== "" ? `.${el.className.trim().split(/\s+/).slice(0, 3).join(".")}` : "";
      const name = (el.getAttribute("aria-label") ?? el.textContent).trim().replace(/\s+/g, " ").slice(0, 30);
      return `${el.tagName.toLowerCase()}${t !== null ? `[data-testid=${t}]` : el.id !== "" ? `#${el.id}` : cls}${name !== "" ? ` "${name}"` : ""}`;
    };
    const out: string[] = [];
    const de = document.documentElement;
    if (de.scrollWidth > W || document.body.scrollWidth > W) out.push(`overflow: scrollWidth ${String(Math.max(de.scrollWidth, document.body.scrollWidth))} > innerWidth ${String(W)}`);
    const INTERACTIVE = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab], [role=menuitem], [role=option], [role=radio], [role=checkbox], [role=slider], [role=switch], [tabindex]:not([tabindex="-1"])';
    const els = [...document.querySelectorAll<HTMLElement>(INTERACTIVE)].filter((el) => {
      if (el.closest("[inert], [hidden], dialog:not([open])") !== null) return false;
      if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
      const r = el.getBoundingClientRect();
      return r.width > 1 && r.height > 1;
    });
    /** Why a focusable control can't be seen: off-screen, or less of it shows than its clipping ancestor allows. */
    const unseen = (el: HTMLElement): string | null => {
      const r = el.getBoundingClientRect();
      // Walk up to the first scroller; remember the first ancestor that clips without scrolling.
      let scroller: Element | null = el.parentElement;
      let clipper: Element | null = null;
      while (scroller !== null && scroller !== de) {
        const cs = getComputedStyle(scroller);
        if (["auto", "scroll"].includes(cs.overflowX) || ["auto", "scroll"].includes(cs.overflowY)) break;
        if (clipper === null && [cs.overflowX, cs.overflowY].some((o) => o === "hidden" || o === "clip")) clipper = scroller;
        scroller = scroller.parentElement;
      }
      if ((scroller === null || scroller === de) && (r.right > W + 1 || r.left < -1)) return `off-screen: ${describe(el)} x=${String(Math.round(r.left))}..${String(Math.round(r.right))} (vw ${String(W)})`;
      if (clipper === null) return null;
      const c = clipper.getBoundingClientRect();
      const visW = Math.min(r.right, c.right) - Math.max(r.left, c.left);
      const visH = Math.min(r.bottom, c.bottom) - Math.max(r.top, c.top);
      if (visW >= Math.min(r.width, c.width) - 2 && visH >= Math.min(r.height, c.height) - 2) return null;
      return `clipped: ${describe(el)} visible ${String(Math.max(0, Math.round(visW)))}x${String(Math.max(0, Math.round(visH)))} of ${String(Math.round(r.width))}x${String(Math.round(r.height))} in ${describe(clipper)}`;
    };
    // Judged with focus on it: a skip link, or a tag the room pans into view on focus (OME-1325), is fine.
    const was = document.activeElement;
    for (const el of els.filter((e) => e.tabIndex >= 0 && !e.matches(":disabled") && unseen(e) !== null)) {
      el.focus();
      // Focus didn't land (an open modal makes the rest of the page inert): not focusable now, so not a finding.
      if (document.activeElement !== el) continue;
      await new Promise((done) => setTimeout(done, 400));
      const why = unseen(el);
      if (why !== null) out.push(why);
    }
    if (was instanceof HTMLElement) was.focus();
    else if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    for (const el of els) {
      if (el.closest(".ui-touch") === null) continue;
      // WCAG 2.5.8 inline exception: a link in running text.
      const parent = el.parentElement;
      if (el.tagName === "A" && parent !== null && ["P", "LI", "DD", "SPAN", "SMALL", "TD"].includes(parent.tagName) && [...parent.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? "").trim() !== "")) continue;
      const target = el instanceof HTMLInputElement && (el.type === "radio" || el.type === "checkbox") ? (el.closest("label") ?? el) : el;
      const t = target.getBoundingClientRect();
      let [w, h] = [t.width, t.height];
      const before = getComputedStyle(target, "::before");
      if (before.content !== "none" && before.position === "absolute") {
        w = Math.max(w, parseFloat(before.width) || 0);
        h = Math.max(h, parseFloat(before.height) || 0);
      }
      if (w < 43.5 || h < 43.5) out.push(`target under 44 px (.ui-touch): ${describe(el)} ${String(Math.round(w))}x${String(Math.round(h))}`);
    }
    return out;
  });

/**
 * Open findings with a fix issue, reported as annotations instead of failures. The fix removes its entry (its red commit).
 * shortcut: an entry no longer seen doesn't fail; prune it when its issue closes.
 */
const KNOWN: readonly { issue: string; surface: string; problem: RegExp }[] = [
];

/** Every problem on the page as it is now, one soft assertion per surface so one test reports them all. */
async function audit(page: Page, vp: string, surface: string): Promise<void> {
  await page.waitForTimeout(400);
  const problems = [...(await axe(page)), ...(await measure(page))];
  const known = (p: string) => KNOWN.find((k) => k.surface === surface && k.problem.test(p));
  for (const p of problems) {
    const k = known(p);
    if (k !== undefined) test.info().annotations.push({ type: `known (${k.issue})`, description: `${vp} ${surface}: ${p}` });
  }
  expect.soft(problems.filter((p) => known(p) === undefined), `${vp} ${surface}`).toEqual([]);
}

let contexts: BrowserContext[] = [];
test.afterEach(async () => {
  await Promise.all(contexts.map((c) => c.close().catch(() => undefined)));
  contexts = [];
});

async function newPage(browser: Browser, vp: VP, secrets?: string): Promise<Page> {
  const context = await watchCsp(await browser.newContext(vp.opts));
  contexts.push(context);
  if (secrets !== undefined) {
    await context.addInitScript(
      ([origin, key, value]) => {
        if (location.origin === origin && localStorage.getItem(key ?? "") === null) localStorage.setItem(key ?? "", value ?? "");
      },
      [URLS.web, ROOM_SECRETS_STORAGE_KEY, secrets],
    );
  }
  await stubExternalNetwork(context);
  return context.newPage();
}

async function enter(page: Page, nickname: string): Promise<void> {
  await page.locator(site.nicknameInput).fill(nickname);
  await page.locator(site.joinButton).click();
  await expect(page.locator(site.room)).toBeVisible();
}

const visibleClick = async (page: Page, selector: string): Promise<boolean> => {
  const l = page.locator(selector).first();
  if (!(await l.isVisible())) return false;
  await l.click();
  return true;
};

/**
 * Opens a surface, audits it and closes it with Escape. `open` returns false when the layout has no opener for it at
 * this viewport; the surfaces skipped that way are compared with `skips` at the end of each test, so a renamed opener
 * fails instead of passing by skipping.
 */
async function step(page: Page, vp: VP, surface: string, skipped: string[], open: () => Promise<boolean>): Promise<void> {
  if (!(await open())) {
    skipped.push(surface);
    return;
  }
  await audit(page, vp.name, surface);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
}

VIEWPORTS.forEach((vp, i) => {
  test.describe(vp.name, () => {
    test("landing, directory, not found, legal pages", async ({ browser }) => {
      const page = await newPage(browser, vp);
      await page.goto(URLS.web);
      await page.waitForLoadState("networkidle");
      await audit(page, vp.name, "landing");
      await openDirectory(page, "Sweeper");
      await audit(page, vp.name, "directory");
      await page.goto(`${URLS.web}/r/${"qanotfoundroom".padEnd(26, "a")}`);
      await page.locator(site.nicknameInput).fill("Sweeper");
      await page.locator(site.joinButton).click();
      await expect(page.locator(site.notFound)).toBeVisible();
      await audit(page, vp.name, "not found");
      for (const p of ["privacy", "terms", "contact", "licenses"]) {
        await page.goto(`${URLS.web}/${p}.html`);
        await audit(page, vp.name, `legal: ${p}`);
      }
    });

    test("room as guest: rest, help, report, share sheet, people, full screen, pop-outs", async ({ browser }) => {
      const page = await newPage(browser, vp);
      const skipped: string[] = [];
      await page.goto(testRoom("a11y-sweep", ROOMS[i] ?? "w1280").url);
      await enter(page, `sweep${String(i)}`);
      await audit(page, vp.name, "guest rest");
      await step(page, vp, "help", skipped, () => visibleClick(page, site.helpKey));
      await step(page, vp, "report", skipped, async () => (await visibleClick(page, site.reportKey)) && (await page.locator(site.reportDialog).isVisible()));
      await step(page, vp, "share sheet", skipped, async () => (await visibleClick(page, id("portrait-link"))) || (await page.locator(site.inviteLink).isVisible()));
      await step(page, vp, "people", skipped, () => visibleClick(page, site.peopleKey));
      if (await page.locator(site.peoplePanel).isVisible()) await page.locator(site.peopleKey).click();
      await step(page, vp, "full screen", skipped, async () => {
        if (!(await visibleClick(page, site.fullscreenToggle))) return false;
        await expect(page.locator(site.fsStrip)).toBeVisible();
        return true;
      });
      await page.evaluate(() => (document.fullscreenElement !== null ? document.exitFullscreen() : undefined));
      await page.waitForTimeout(600);
      for (const [key, path, ready] of [[site.chatPopout, "chat.html", site.chatInput], [site.roomPopout, "room.html", `${site.poproomRoom} canvas`]] as const) {
        const k = page.locator(key).first();
        if (!(await k.isVisible())) {
          skipped.push(`pop-out ${path}`);
          continue;
        }
        const [pop] = await Promise.all([page.context().waitForEvent("page"), k.click()]);
        await pop.waitForLoadState();
        await pop.locator(ready).first().waitFor({ timeout: 15_000 });
        await audit(pop, vp.name, `pop-out ${path}`);
        await audit(page, vp.name, `placeholder for ${path}`);
        await pop.close();
        await page.waitForTimeout(800);
        const back = page.locator(`${site.chatBringBack}, ${site.roomBringBack}`).first();
        if (await back.isVisible()) await back.click();
      }
      expect(skipped, "surfaces with no opener at this viewport").toEqual(GUEST_SKIPS[vp.name] ?? []);
    });

    test("room as owner: rest, share sheet, member menu, editor", async ({ browser }) => {
      const { id: roomId, ownerToken, inviteKey } = ownedRoom(OWNED[i] ?? "sweepa");
      const owner = await newPage(browser, vp, JSON.stringify({ v: 1, rooms: { [roomId]: { ownerToken, inviteKey } } }));
      const skipped: string[] = [];
      await owner.goto(`${URLS.web}/r/${roomId}`);
      await enter(owner, "host");
      const guest = await newPage(browser, VIEWPORTS[0] ?? vp);
      await guest.goto(`${URLS.web}/r/${roomId}#k=${inviteKey}`);
      await enter(guest, "kit");
      await audit(owner, vp.name, "owner rest");
      // QA OME-1460: a guest's 4-option poll beside the owner's panels, then the owner closes it.
      await guest.locator(site.chatInput).fill("/poll Sizes? A | B | C | D");
      await guest.locator(site.chatInput).press("Enter");
      const poll = owner.locator('[data-testid="poll-card"]');
      await expect(poll).toBeVisible();
      await audit(owner, vp.name, "owner poll");
      await poll.locator("button.poll-close").click();
      await expect(poll).toBeHidden();
      await step(owner, vp, "owner share sheet", skipped, async () => (await visibleClick(owner, id("portrait-link"))) || (await owner.locator(site.inviteLink).isVisible()));
      await step(owner, vp, "member menu", skipped, async () => {
        // In portrait the tags may live in the People list instead.
        if ((await owner.locator(`${site.nicknameTag}[role=button]`).filter({ hasText: "kit" }).count()) === 0) await visibleClick(owner, site.peopleKey);
        await owner.locator(`${site.nicknameTag}[role=button], ${site.peopleRow} [role=button], ${site.peopleRow} button`).filter({ hasText: "kit" }).first().focus();
        await owner.keyboard.press("Enter");
        await expect(owner.locator(site.modMenu)).toBeVisible({ timeout: 5000 });
        return true;
      });
      await step(owner, vp, "editor", skipped, async () => {
        const settings = owner.locator(id("portrait-settings"));
        if (await settings.isVisible()) await settings.click();
        if (!(await visibleClick(owner, site.editRoom))) return false;
        await expect(owner.locator(site.editorTray)).toBeVisible();
        return true;
      });
      expect(skipped, "surfaces with no opener at this viewport").toEqual(OWNER_SKIPS[vp.name] ?? []);
    });
  });
});

/** Surfaces a viewport's layout has no opener for, by design: no pop-outs on a phone, no report key or editor in portrait. */
const GUEST_SKIPS: Record<string, string[]> = {
  "390x844-touch": ["report", "pop-out chat.html", "pop-out room.html"],
  "844x390-touch": ["pop-out chat.html", "pop-out room.html"],
  "320x640": ["report", "pop-out chat.html", "pop-out room.html"],
};
const OWNER_SKIPS: Record<string, string[]> = { "390x844-touch": ["editor"], "320x640": ["editor"] };

async function extAudit(page: Page, surface: string, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  await audit(page, `${String(width)}x${String(height)}`, `extension ${surface}`);
}

/** The popup, options and consent pages; on a phone, a touch pointer with no hover, as extension-phone.e2e.ts (F7, OME-1300). */
for (const [name, width, height, wide] of [["desktop", 360, 600, 1280], ["phone", 320, 640, 320]] as const) {
  test.describe(`extension on a ${name}`, () => {
    if (name === "phone") test.use({ extraArgs: ["--blink-settings=primaryPointerType=2,availablePointerTypes=2,primaryHoverType=1,availableHoverTypes=1"] });
    test("popup with an embed, options, consent", async ({ context, openPopup, extensionId }) => {
      const source = await context.newPage();
      await gotoFixture(source, "youtube-embed");
      const popup = await openPopup(source);
      await popup.setViewportSize({ width, height });
      // The popup sizes itself at load (extension-phone.e2e.ts reloads too).
      await popup.reload();
      await popup.locator(id("embed-item")).first().waitFor();
      expect(await popup.evaluate(() => matchMedia("(hover: none)").matches)).toBe(name === "phone");
      await extAudit(popup, "popup", width, height);
      const options = await context.newPage();
      await options.goto(`chrome-extension://${extensionId}/options.html`);
      await extAudit(options, "options", wide, 800);
      const consent = await context.newPage();
      await consent.goto(`chrome-extension://${extensionId}/consent.html?host=media.example.org&tabId=1`);
      await extAudit(consent, "consent", wide, 800);
    });
  });
}
