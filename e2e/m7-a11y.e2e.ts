// OME-602 (M7 Q1): the accessibility pass over every NEW M7 surface, three ways.
//  1. One keyboard-only walk (no mouse: page.keyboard only) through the whole M7 flow: land, join as a guest, sit, chat with
//     Enter → type → Enter, full screen in and out, pop the chat out and back, report the room, Close. At every stop the
//     focus must be on a visible element with a visible focus indicator (outline or box-shadow on :focus-visible), and
//     never on <body>.
//  2. axe (wcag2a, wcag2aa, wcag21a, wcag21aa) with zero violations on: the wide layout (1280×720, 1920×1080), the phone
//     layout, the full-screen strip and its collapsed input bar, the pop-out chat window (chat.html), the pop-out room
//     window (room.html), the quality menu, the report dialog and its sent state, the takedown notice, the chat log with
//     lines. Provider iframes (the third party's own document, not ours) are the only thing excluded, explicitly.
//  3. Reduced motion (emulateMedia reduce): no CSS animation or transition that runs longer than a blink (checked from
//     animation/transition events and document.getAnimations()) on chat line arrival, full-screen enter/leave, the strip's
//     collapse/expand, the pop-out placeholder and the report dialog; and every key/field on those surfaces has a
//     non-empty accessible name.
// Rooms: each test has its own seeded room (support/test-rooms.ts, "m7-a11y"), so a full parallel run never shares one
// with another spec or test. Report answers are mocked in the page, so no
// report reaches the shared server state (report.e2e.ts expects the first one from its client to be "received").
import AxeBuilder from "@axe-core/playwright";
import type { Browser, BrowserContext, BrowserContextOptions, Page } from "@playwright/test";
import { CLOSE_CODES } from "@omega/shared";
import { expect, test, watchCsp } from "./support/csp";
import { PENDING, URLS, available } from "./support/apps";
import { stubExternalNetwork } from "./support/network";
import { joinRoom, leaveAll, testRoom, type Client } from "./support/room";
import { site } from "./support/selectors";
import { providerCase, shareProvider, waitProviderPlaying } from "../perf/providers";

test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);
test.setTimeout(90_000);

const DESKTOP = (width: number, height: number): BrowserContextOptions => ({ viewport: { width, height } });
const PHONE: BrowserContextOptions = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const REPORT_PATH = /\/rooms\/[^/]+\/report$/;
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
/** Known product bug (see the test.fail below): chat lines are <li>s in a role=log <div>. The three surfaces that show lines ignore it. */
const LOG_LIST = ["listitem"];

let clients: Client[] = [];
let extra: BrowserContext[] = [];
test.afterEach(async () => {
  await leaveAll(clients);
  await Promise.all(extra.map((c) => c.close()));
  clients = [];
  extra = [];
});

// --- helpers --------------------------------------------------------------------------------------------------------

async function join(browser: Browser, room: { url: string }, count = 1, options?: BrowserContextOptions, setup?: (context: BrowserContext, index: number) => Promise<void>): Promise<Client[]> {
  clients = await joinRoom(browser, {
    roomUrl: room.url,
    count,
    nicknamePrefix: "ax",
    contextOptions: (i) => (i === 0 ? options : undefined),
    ...(setup === undefined ? {} : { setup }),
  });
  return clients;
}

async function first(browser: Browser, room: { url: string }, options?: BrowserContextOptions, setup?: (context: BrowserContext, index: number) => Promise<void>): Promise<Page> {
  const [a] = await join(browser, room, 1, options, setup);
  if (a === undefined) throw new Error("no client");
  return a.page;
}

/** A second member, for chat lines the first one reads. */
async function say(page: Page, text: string): Promise<void> {
  await page.locator(site.chatInput).fill(text);
  await page.locator(site.chatInput).press("Enter");
}

const inFullscreen = (page: Page): Promise<boolean> => page.evaluate((sel) => document.fullscreenElement?.matches(sel) === true, site.fsRoot);

/** Answers the report POST in the page: nothing reaches the shared server (see the header). */
async function mockReport(context: BrowserContext, status: "received" | "already_reported" = "received"): Promise<void> {
  await context.route(REPORT_PATH, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await route.fulfill({ status: status === "received" ? 202 : 200, contentType: "application/json", headers: { "access-control-allow-origin": URLS.web }, body: JSON.stringify({ ok: true, status }) });
  });
}

/** Opens the report dialog with the keyboard and returns once it shows. */
async function openReport(page: Page): Promise<void> {
  await page.locator(site.reportKey).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(site.reportDialog)).toBeVisible();
}

// axe ------------------------------------------------------------------------------------------------------------------

type Violation = Awaited<ReturnType<AxeBuilder["analyze"]>>["violations"][number];
const describe = (v: Violation): string => `${v.id} (${v.impact ?? "?"}): ${v.help} | ${v.nodes.map((n) => `${n.target.join(" ")} [${n.any.map((c) => c.message).join(" / ")}]`).join(" ; ")}`;

/**
 * Contrast axe can't compute: our keys and chat lines are painted by `border-image` slices (assets/ui/slices), which axe
 * doesn't read, so it falls back to the page colour behind them (an unreadable 1.06 : 1 on every key and line). For
 * those nodes this reads the slice the way the browser paints it, takes the colour that fills most of its middle, and
 * applies WCAG's own thresholds (4.5 : 1, or 3 : 1 for large text) to the node's text colour. Returns one line per node
 * that really fails, or that has no painted background to read (so it can't be passed by accident).
 */
const paintedContrast = (page: Page, selector: string): Promise<string[]> =>
  page.evaluate(async (sel): Promise<string[]> => {
    const channel = (c: number): number => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (rgb: readonly number[]): number => 0.2126 * channel(rgb[0] ?? 0) + 0.7152 * channel(rgb[1] ?? 0) + 0.0722 * channel(rgb[2] ?? 0);
    const out: string[] = [];
    for (const el of document.querySelectorAll(sel)) {
      let painter: Element | null = el;
      while (painter !== null && getComputedStyle(painter).borderImageSource === "none") painter = painter.parentElement;
      const url = painter === null ? null : /url\("?([^")]+)"?\)/.exec(getComputedStyle(painter).borderImageSource)?.[1];
      if (url === undefined || url === null) {
        out.push(`${sel}: no painted background to read`);
        continue;
      }
      const image = new Image();
      image.src = url;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const ctx = canvas.getContext("2d");
      if (ctx === null) throw new Error("no 2d context");
      ctx.drawImage(image, 0, 0);
      const w = Math.max(1, Math.floor(canvas.width * 0.5));
      const h = Math.max(1, Math.floor(canvas.height * 0.5));
      const data = ctx.getImageData(Math.floor(canvas.width * 0.25), Math.floor(canvas.height * 0.25), w, h).data;
      const counts = new Map<string, number>();
      for (let i = 0; i < data.length; i += 4) {
        if ((data[i + 3] ?? 0) < 255) continue;
        const k = `${String(data[i])},${String(data[i + 1])},${String(data[i + 2])}`;
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      const top = [...counts.entries()].sort((p, q) => q[1] - p[1])[0];
      if (top === undefined) {
        out.push(`${sel}: the painted background has no opaque middle`);
        continue;
      }
      const bg = top[0].split(",").map(Number);
      const cs = getComputedStyle(el);
      const fg = (cs.color.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number);
      const [hi, lo] = [luminance(fg), luminance(bg)].sort((p, q) => q - p);
      const ratio = ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
      const px = parseFloat(cs.fontSize);
      const need = px >= 24 || (px >= 18.66 && Number(cs.fontWeight) >= 700) ? 3 : 4.5;
      if (ratio < need) out.push(`${sel}: text rgb(${fg.join(",")}) on painted rgb(${bg.join(",")}) is ${ratio.toFixed(2)} : 1, needs ${String(need)} : 1`);
    }
    return out;
  }, selector);

/**
 * Runs axe over the page's own document. Provider iframes are excluded: they are the third party's documents (the
 * player's own markup), not ours; the frame element itself is covered by our `title`. Contrast on border-image
 * backgrounds is judged by `paintedContrast` instead of axe's blind guess.
 */
async function violations(page: Page, ignore: readonly string[] = []): Promise<string[]> {
  const result = await new AxeBuilder({ page }).withTags(TAGS).exclude("iframe").analyze();
  const out: string[] = [];
  // `ignore` is for known product bugs that have a test.fail of their own below; everything else must be zero.
  const seen = result.violations.filter((v) => !ignore.includes(v.id));
  for (const v of seen) {
    if (v.id !== "color-contrast") {
      out.push(describe(v));
      continue;
    }
    for (const n of v.nodes) {
      const [selector] = n.target;
      if (typeof selector === "string") out.push(...(await paintedContrast(page, selector)));
      else out.push(`color-contrast: ${n.target.join(" ")} (inside a shadow root or frame)`);
    }
  }
  return out;
}

// focus ----------------------------------------------------------------------------------------------------------------

interface Stop {
  readonly what: string;
  readonly visible: boolean;
  readonly focusVisible: boolean;
  readonly indicator: boolean;
}

const stopOf = (page: Page): Promise<Stop> =>
  page.evaluate((): Stop => {
    const el = document.activeElement;
    if (el === null || el === document.body || el === document.documentElement) return { what: "body", visible: false, focusVisible: false, indicator: false };
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const what = el.getAttribute("data-testid") ?? `${el.tagName.toLowerCase()}${el.id === "" ? "" : `#${el.id}`}`;
    return {
      what,
      visible: r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && el.getClientRects().length > 0,
      focusVisible: el.matches(":focus-visible"),
      indicator: (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== "none",
    };
  });

/**
 * Records a problem when focus is on <body> (given a moment to land: an app may move it a tick after the key), off
 * screen, not :focus-visible, or without an outline / box-shadow. On a Tab press <body> isn't a finding: Tab past the
 * last stop of a page leaves it for the browser's own chrome, which headless Chromium reports as <body>.
 */
async function checkFocus(page: Page, step: string, problems: string[], onTab = false): Promise<string> {
  let s = await stopOf(page);
  for (let i = 0; i < 8 && s.what === "body" && !onTab; i++) {
    await page.waitForTimeout(100);
    s = await stopOf(page);
  }
  if (s.what === "body") {
    if (!onTab) problems.push(`${step}: focus fell to <body>`);
  } else if (!s.visible) problems.push(`${step}: focus on ${s.what}, which is not visible`);
  else if (!s.focusVisible) problems.push(`${step}: ${s.what} is focused but not :focus-visible after a key press`);
  else if (!s.indicator) problems.push(`${step}: ${s.what} has no visible focus indicator (outline-style none and no box-shadow)`);
  return s.what;
}

/** Tab (or Shift+Tab) until `testId` has focus, checking every stop on the way. Throws if it is never reached. */
async function tabTo(page: Page, testId: string, step: string, problems: string[], key = "Tab", max = 60): Promise<void> {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press(key);
    const what = await checkFocus(page, `${step} (stop ${String(i + 1)})`, problems, true);
    if (what === testId) return;
  }
  throw new Error(`${step}: ${testId} not reached in ${String(max)} ${key} presses`);
}

const mySeat = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const debug: unknown = Reflect.get(window, "__omega");
    const room: unknown = typeof debug === "object" && debug !== null ? Reflect.get(debug, "room") : null;
    const f: unknown = typeof room === "object" && room !== null ? Reflect.get(room, "state") : null;
    const s: unknown = typeof f === "function" ? Reflect.apply(f, room, []) : null;
    if (typeof s !== "object" || s === null) return -1;
    const self: unknown = Reflect.get(s, "self");
    const r: unknown = Reflect.get(s, "room");
    const seats: unknown = typeof r === "object" && r !== null ? Reflect.get(r, "seats") : null;
    return Array.isArray(seats) ? seats.indexOf(self) : -1;
  });

// motion ---------------------------------------------------------------------------------------------------------------

/** A CSS animation or transition seen running, with its total length (delay + duration) in ms. */
interface Motion {
  readonly what: string;
  readonly ms: number;
}
/** Longer than this (ms) and it's motion; anything shorter is a state change a person can't see. */
const BLINK_MS = 20;

/** Init script: logs every CSS animation / transition that starts, with its length, into window.__motion. */
function watchMotion(): void {
  const seen: { what: string; ms: number }[] = [];
  Reflect.set(window, "__motion", seen);
  const note = (): void => {
    for (const a of document.getAnimations()) {
      if (!(a instanceof CSSAnimation || a instanceof CSSTransition)) continue;
      const name = a instanceof CSSAnimation ? a.animationName : a.transitionProperty;
      const t = a.effect;
      const ms = t === null ? 0 : Number(t.getComputedTiming().endTime);
      const target = t instanceof KeyframeEffect ? t.target : null;
      const where = target instanceof Element ? (target.getAttribute("data-testid") ?? (target.getAttribute("class") ?? target.tagName)) : "?";
      seen.push({ what: `${name} on ${where}`, ms });
    }
  };
  document.addEventListener("animationstart", () => { setTimeout(note, 0); }, true);
  document.addEventListener("transitionrun", () => { setTimeout(note, 0); }, true);
}

const motionSeen = (page: Page): Promise<Motion[]> =>
  page.evaluate((): Motion[] => {
    const log: unknown = Reflect.get(window, "__motion");
    const out: Motion[] = Array.isArray(log) ? (log as Motion[]).slice() : [];
    for (const a of document.getAnimations()) {
      if (!(a instanceof CSSAnimation || a instanceof CSSTransition)) continue;
      const ms = a.effect === null ? 0 : Number(a.effect.getComputedTiming().endTime);
      out.push({ what: `running ${a instanceof CSSAnimation ? a.animationName : a.transitionProperty}`, ms });
    }
    return out;
  });

/** Asserts nothing longer than a blink ran since the page opened (the log is cumulative, so ask after each trigger). */
async function expectStill(page: Page, step: string): Promise<void> {
  await page.waitForTimeout(150);
  const long = (await motionSeen(page)).filter((m) => m.ms > BLINK_MS);
  expect(long, `${step}: CSS motion under reduced motion`).toEqual([]);
}

/** Every visible key, field and radio on the page has an accessible name. */
async function expectNamed(page: Page, step: string): Promise<void> {
  // Playwright computes the accessible name the way the browser does; ask it per element.
  const all = await page.locator("button, input:not([type=hidden]), textarea, select, [role=button], [role=radio], [role=menuitem], [role=menuitemradio], a[href]").all();
  let checked = 0;
  for (const l of all) {
    if (!(await l.isVisible())) continue;
    const label = (await l.getAttribute("data-testid")) ?? (await l.evaluate((e) => e.tagName.toLowerCase()));
    await expect(l, `${step}: ${label} needs an accessible name`).toHaveAccessibleName(/\S/);
    checked++;
  }
  expect(checked, `${step}: found keys to check`).toBeGreaterThan(0);
}

// --- 1. the keyboard-only walk --------------------------------------------------------------------------------------

/**
 * Product bugs this walk found. The walk itself fails on anything else; each of these has a test.fail below that
 * asserts the walk found none of it, so the day one is fixed its test.fail turns red and gets flipped.
 */
const KNOWN = {
  joinFocus: /^after joining: focus fell to <body>/,
  seatRing: /^[^:]+: seat has no visible focus indicator/,
  queueUrlRing: /^[^:]+: queue-url has no visible focus indicator/,
  reportNoteRing: /^[^:]+: report-note has no visible focus indicator/,
  fsExitFocus: /^after Esc out of full screen: focus fell to <body>/,
} as const;
const isKnown = (p: string): boolean => Object.values(KNOWN).some((re) => re.test(p));
let walked: string[] | null = null;

test.describe.serial("the keyboard-only walk", () => {
test("keyboard only, no mouse: join, sit, chat, full screen in and out, chat out and back, report, Close; focus is always visible and never on <body>", async ({ browser }) => {
  walked = null;
  const room = testRoom("m7-a11y", "walkseat");
  const problems: string[] = [];
  // A second member reads the chat (joined the usual way: this is not the walk under test).
  const [b] = await join(browser, room);
  if (b === undefined) throw new Error("no helper");

  const context = await watchCsp(await browser.newContext());
  extra.push(context);
  await stubExternalNetwork(context);
  await mockReport(context);
  const page = await context.newPage();

  // Land on the site and join as a guest.
  await page.goto(room.url);
  await tabTo(page, "nickname-input", "land", problems);
  await page.keyboard.type("axkeys");
  await tabTo(page, "avatar-option", "avatar", problems);
  await page.keyboard.press("ArrowRight");
  await checkFocus(page, "avatar picked", problems);
  await tabTo(page, "join-button", "join", problems);
  await page.keyboard.press("Enter");
  await expect(page.locator(site.room)).toBeVisible();
  await checkFocus(page, "after joining", problems);

  // Sit: Tab to a seat, Enter.
  await tabTo(page, "seat", "to a seat", problems);
  await page.keyboard.press("Enter");
  await expect.poll(() => mySeat(page)).toBeGreaterThanOrEqual(0);
  await checkFocus(page, "after sitting", problems);

  // Chat: Enter jumps to the field, type, Enter sends and stays.
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.keyboard.press("Enter");
  await expect(page.locator(site.chatInput)).toBeFocused();
  await checkFocus(page, "chat field", problems);
  await page.keyboard.type("hello by keyboard");
  await page.keyboard.press("Enter");
  await expect(b.page.locator(site.chatLogLine).last()).toContainText("hello by keyboard");
  await checkFocus(page, "after sending", problems);
  // Esc hands the keys back by design (wide-layout.e2e.ts): the field blurs and the next Tab carries on from it.
  await page.keyboard.press("Escape");

  // Full screen: the key enters (Enter), the browser's Esc leaves (CDP Escape never reaches it: exitFullscreen is what
  // the browser does on Esc, as in fullscreen.e2e.ts), then the F key goes in and out.
  await tabTo(page, "fullscreen-toggle", "to full screen", problems);
  await page.keyboard.press("Enter");
  await expect.poll(() => inFullscreen(page)).toBe(true);
  await checkFocus(page, "in full screen", problems);
  await tabTo(page, "fs-strip-toggle", "to the strip's key", problems, "Tab", 40);
  await page.keyboard.press("Enter");
  await expect(page.locator(site.fsStripToggle)).toHaveAttribute("aria-expanded", "false");
  await checkFocus(page, "after collapsing the strip", problems);
  await page.keyboard.press("Enter");
  await expect(page.locator(site.fsStripToggle)).toHaveAttribute("aria-expanded", "true");
  await page.evaluate(() => document.exitFullscreen());
  await expect.poll(() => inFullscreen(page)).toBe(false);
  await expect(page.locator(site.fsStrip)).toBeHidden();
  await checkFocus(page, "after Esc out of full screen", problems);
  // A new request right as Chromium finishes leaving can be refused, so give it a moment (as fullscreen.e2e.ts does).
  await page.waitForTimeout(500);
  await tabTo(page, "fullscreen-toggle", "back to the key", problems);
  await page.keyboard.press("Enter");
  await expect.poll(() => inFullscreen(page)).toBe(true);
  await page.keyboard.press("Enter");
  await expect.poll(() => inFullscreen(page)).toBe(false);
  await expect(page.locator(site.fullscreenToggle)).toBeFocused();
  await checkFocus(page, "after the key left full screen", problems);

  // Pop the chat out and back.
  await tabTo(page, "chat-popout", "to the pop-out key", problems, "Tab", 80);
  const [pop] = await Promise.all([context.waitForEvent("page"), page.keyboard.press("Enter")]);
  await pop.waitForLoadState();
  await expect(pop.locator(site.chatInput)).toBeVisible();
  await expect(page.locator(site.chatAway)).toBeVisible();
  await checkFocus(page, "room tab after the pop-out", problems);
  await pop.keyboard.press("Tab");
  await checkFocus(pop, "pop-out window, first Tab", problems);
  await tabTo(page, "chat-bring-back", "to bring-back", problems, "Tab", 80);
  const closed = pop.waitForEvent("close");
  await page.keyboard.press("Enter");
  await closed;
  await expect(page.locator(site.chatInput)).toBeVisible();
  await checkFocus(page, "after bringing the chat back", problems);

  // Report the room: the last key of the room; pick a reason, note, send, Close.
  await tabTo(page, "report-key", "to the report key", problems, "Tab", 80);
  await page.keyboard.press("Enter");
  await expect(page.locator(site.reportDialog)).toBeVisible();
  await checkFocus(page, "report dialog opened", problems);
  await page.keyboard.press("ArrowDown");
  await checkFocus(page, "reason picked", problems);
  await page.keyboard.press("Tab");
  await checkFocus(page, "report note", problems);
  await page.keyboard.type("Keyboard walk, not a real report.");
  await tabTo(page, "report-send", "to Send", problems, "Tab", 5);
  await page.keyboard.press("Enter");
  await expect(page.locator(site.reportSent)).toBeVisible();
  await checkFocus(page, "report sent", problems);
  await page.keyboard.press("Enter");
  await expect(page.locator(site.reportDialog)).toBeHidden();
  await checkFocus(page, "report closed", problems);
  await expect(page.locator(site.reportKey)).toBeFocused();

  walked = problems;
  expect(problems.filter((p) => !isKnown(p))).toEqual([]);
});

// Each is a real finding; the walk's own assertion above excludes it so one bug can't hide another.
// Tracked in OME-701: when a fix lands, its test.fail turns red; drop the entry (and its KNOWN pattern) there.
const knownBugs: readonly [string, RegExp, string][] = [
  ["after joining by keyboard the focus is not left on <body>: the form that held it is removed", KNOWN.joinFocus, "Enter on 'Enter room' removes the landing form (the focused element) and nothing takes focus"],
  ["every seat shows a focus indicator (outline or box-shadow), not only a tint", KNOWN.seatRing, "`.seat:focus-visible { outline: none }` leaves only a 35% background tint on desktop (style.css:81; only .ui-touch gets an outline)"],
  ["the Up next paste field shows a focus indicator (outline or box-shadow)", KNOWN.queueUrlRing, "[data-testid=queue-url] (.ui-input) swaps its border-image slice on focus and has outline: none"],
  ["the report note field shows a focus indicator (outline or box-shadow)", KNOWN.reportNoteRing, "[data-testid=report-note] (.ui-input) swaps its border-image slice on focus and has outline: none"],
  ["Esc out of full screen with focus on the strip's key leaves focus on a visible element, not <body>", KNOWN.fsExitFocus, "focus was on [data-testid=fs-strip-toggle], which is hidden again outside full screen; nothing takes focus"],
];
for (const [title, re, why] of knownBugs) {
  test(`known bug: ${title}`, () => {
    test.skip(walked === null, "the walk did not run");
    test.fail(true, `OME-701: ${why}`);
    expect((walked ?? []).filter((p) => re.test(p))).toEqual([]);
  });
}
});

// --- 2. axe on every new surface ------------------------------------------------------------------------------------

test.describe("axe: zero violations on each new M7 surface", () => {
  for (const [name, w, h] of [["w1280", 1280, 720], ["w1920", 1920, 1080]] as const) {
    test(`wide layout ${String(w)}×${String(h)}`, async ({ browser }) => {
      const page = await first(browser, testRoom("m7-a11y", name), DESKTOP(w, h));
      await expect(page.locator(site.chatInput)).toBeVisible();
      expect(await violations(page)).toEqual([]);
    });
  }

  test("phone layout (390×844, touch)", async ({ browser }) => {
    const page = await first(browser, testRoom("m7-a11y", "phone"), PHONE);
    await expect(page.locator(site.chatInput)).toBeVisible();
    expect(await violations(page)).toEqual([]);
  });

  test("full-screen strip, then its collapsed input bar", async ({ browser }) => {
    const [a, b] = await join(browser, testRoom("m7-a11y", "fs"), 2, DESKTOP(1280, 720));
    if (a === undefined || b === undefined) throw new Error("need 2 clients");
    await say(b.page, "a line in the strip");
    await a.page.locator(site.fullscreenToggle).focus();
    await a.page.keyboard.press("Enter");
    await expect.poll(() => inFullscreen(a.page)).toBe(true);
    await expect(a.page.locator(site.fsStrip).locator(site.chatLogLine).last()).toContainText("a line in the strip");
    expect(await violations(a.page, LOG_LIST), "strip").toEqual([]);
    await a.page.locator(site.fsStripToggle).focus();
    await a.page.keyboard.press("Enter");
    await expect(a.page.locator(site.fsStripToggle)).toHaveAttribute("aria-expanded", "false");
    expect(await violations(a.page, LOG_LIST), "collapsed input bar").toEqual([]);
  });

  test("pop-out chat window (chat.html)", async ({ browser }) => {
    const [a, b] = await join(browser, testRoom("m7-a11y", "chatwin"), 2);
    if (a === undefined || b === undefined) throw new Error("need 2 clients");
    await say(b.page, "a line for the window");
    const [pop] = await Promise.all([a.context.waitForEvent("page"), a.page.locator(site.chatPopout).click()]);
    await pop.waitForLoadState();
    await expect(pop.locator(site.chatLogLine).last()).toContainText("a line for the window");
    expect(new URL(pop.url()).pathname).toBe("/chat.html");
    expect(await violations(pop, LOG_LIST), "chat.html").toEqual([]);
    expect(await violations(a.page), "the room tab's placeholder").toEqual([]);
  });

  test("pop-out room window (room.html)", async ({ browser }) => {
    const [a] = await join(browser, testRoom("m7-a11y", "roomwin"));
    if (a === undefined) throw new Error("no client");
    const [pop] = await Promise.all([a.context.waitForEvent("page"), a.page.locator(site.roomPopout).click()]);
    await pop.waitForLoadState();
    await expect(pop.locator(`${site.poproomRoom} canvas`)).toBeVisible();
    await expect(pop.locator(site.chatInput)).toBeEnabled();
    expect(new URL(pop.url()).pathname).toBe("/room.html");
    expect(await violations(pop), "room.html").toEqual([]);
    await expect(a.page.locator(site.roomAway)).toBeVisible();
    expect(await violations(a.page), "the room tab's placeholder").toEqual([]);
  });

  test("quality menu open (fake Twitch VOD)", async ({ browser, request }) => {
    const room = testRoom("m7-a11y", "quality");
    await shareProvider(request, providerCase("twitchVod").shareUrl, room.id);
    const [a] = await join(browser, room);
    if (a === undefined) throw new Error("no client");
    await waitProviderPlaying([a], "twitch");
    const key = a.page.locator('[data-testid="quality-key"]');
    await key.focus();
    await a.page.keyboard.press("Enter");
    await expect(a.page.locator('[data-testid="quality-menu"]')).toBeVisible();
    expect(await violations(a.page)).toEqual([]);
  });

  test("report dialog open, then the sent state", async ({ browser }) => {
    const page = await first(browser, testRoom("m7-a11y", "states"), undefined, async (context) => {
      await mockReport(context);
    });
    await openReport(page);
    expect(await violations(page), "dialog open").toEqual([]);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Tab");
    await page.keyboard.type("A note.");
    expect(await violations(page), "dialog with a reason and a note").toEqual([]);
    await page.locator(site.reportSend).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(site.reportSent)).toBeVisible();
    expect(await violations(page), "sent").toEqual([]);
  });

  test("the takedown notice (4006)", async ({ browser }) => {
    const routes: Parameters<Parameters<BrowserContext["routeWebSocket"]>[1]>[0][] = [];
    const page = await first(browser, testRoom("m7-a11y", "gone"), undefined, async (context) => {
      await context.routeWebSocket(/\/rooms\/[^/]+\/ws$/, (ws) => {
        routes.push(ws);
        ws.connectToServer();
      });
    });
    await expect(page.locator(site.connectionStatus)).toHaveText("");
    await routes[0]?.close({ code: CLOSE_CODES.TAKEN_DOWN, reason: "taken down" });
    await expect(page.locator(site.roomClosed)).toBeVisible();
    expect(await violations(page)).toEqual([]);
  });

  test("the chat log with lines", async ({ browser }) => {
    const [a, b] = await join(browser, testRoom("m7-a11y", "log"), 2, DESKTOP(1280, 720));
    if (a === undefined || b === undefined) throw new Error("need 2 clients");
    await say(a.page, "first line");
    await say(b.page, "a reply with <b>markup</b> and a rather long run of words that wraps onto the next line of the log");
    await say(a.page, "third line");
    await expect(a.page.locator(site.chatLogLine).last()).toContainText("third line");
    expect(await violations(a.page, LOG_LIST)).toEqual([]);
  });

  // The same log component sits in the page, the full-screen strip and chat.html, so one test.fail records it for all three.
  test("known bug: chat lines are <li>s directly inside a role=log <div>, which axe rule `listitem` rejects", async ({ browser }) => {
    test.fail(true, "OME-701: [data-testid=chat-log] is a div with role=log holding <li> lines: wrap them in a <ul>/<ol> or make them role=listitem inside role=list");
    const page = await first(browser, testRoom("m7-a11y", "logone"), DESKTOP(1280, 720));
    await say(page, "a line");
    await expect(page.locator(site.chatLogLine).last()).toContainText("a line");
    expect(await violations(page)).toEqual([]);
  });
});

// --- 3. reduced motion + names --------------------------------------------------------------------------------------

test.describe("reduced motion: nothing animates for more than a blink, every key is named", () => {
  const reduced = (extraOptions: BrowserContextOptions = {}): BrowserContextOptions => ({ reducedMotion: "reduce", ...extraOptions });
  const watched = async (context: BrowserContext): Promise<void> => {
    await context.addInitScript(watchMotion);
  };

  // The control: without the preference the same watcher does see motion, so a quiet log below means the page is still
  // and not that the watcher is blind.
  test("control: with no preference the watcher sees the surfaces move", async ({ browser }) => {
    const [a, b] = await join(browser, testRoom("m7-a11y", "motion"), 2, DESKTOP(1280, 720), async (context, i) => {
      if (i === 0) await watched(context);
    });
    if (a === undefined || b === undefined) throw new Error("need 2 clients");
    await say(b.page, "a line arrives");
    await expect(a.page.locator(site.chatLogLine).last()).toContainText("a line arrives");
    await openReport(a.page);
    await expect.poll(async () => (await motionSeen(a.page)).filter((m) => m.ms > BLINK_MS).length, { timeout: 8000 }).toBeGreaterThan(0);
  });

  test("chat line arrival, full-screen enter/leave, strip collapse/expand", async ({ browser }) => {
    const [a, b] = await join(browser, testRoom("m7-a11y", "motionrm"), 2, reduced(DESKTOP(1280, 720)), async (context, i) => {
      if (i === 0) await watched(context);
    });
    if (a === undefined || b === undefined) throw new Error("need 2 clients");
    const page = a.page;
    expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);

    await say(b.page, "a line arrives");
    await expect(page.locator(site.chatLogLine).last()).toContainText("a line arrives");
    await say(page, "and one of mine");
    await expect(b.page.locator(site.chatLogLine).last()).toContainText("and one of mine");
    await expectStill(page, "chat line arrival");
    await expectNamed(page, "room");

    await page.locator(site.fullscreenToggle).focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => inFullscreen(page)).toBe(true);
    await expectStill(page, "entering full screen");
    await say(b.page, "a line in full screen");
    await expect(page.locator(site.fsStrip).locator(site.chatLogLine).last()).toContainText("a line in full screen");
    await expectNamed(page, "full-screen strip");

    await page.locator(site.fsStripToggle).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(site.fsStripToggle)).toHaveAttribute("aria-expanded", "false");
    await expectStill(page, "collapsing the strip");
    await expectNamed(page, "collapsed input bar");
    await page.keyboard.press("Enter");
    await expect(page.locator(site.fsStripToggle)).toHaveAttribute("aria-expanded", "true");
    await expectStill(page, "expanding the strip");

    await page.evaluate(() => document.exitFullscreen());
    await expect.poll(() => inFullscreen(page)).toBe(false);
    await expectStill(page, "leaving full screen");
  });

  test("the pop-out placeholder, the chat window and the room window", async ({ browser }) => {
    const [a] = await join(browser, testRoom("m7-a11y", "reduced"), 1, reduced(), async (context) => {
      await watched(context);
    });
    if (a === undefined) throw new Error("no client");
    const [pop] = await Promise.all([a.context.waitForEvent("page"), a.page.locator(site.chatPopout).click()]);
    await pop.waitForLoadState();
    await expect(a.page.locator(site.chatAway)).toBeVisible();
    await expectStill(a.page, "chat pop-out placeholder");
    await expectStill(pop, "chat window");
    await expectNamed(a.page, "chat placeholder");
    await expectNamed(pop, "chat window");
    const closed = pop.waitForEvent("close");
    await a.page.locator(site.chatBringBack).focus();
    await a.page.keyboard.press("Enter");
    await closed;

    const [room] = await Promise.all([a.context.waitForEvent("page"), a.page.locator(site.roomPopout).click()]);
    await room.waitForLoadState();
    await expect(a.page.locator(site.roomAway)).toBeVisible();
    await expectStill(a.page, "room pop-out placeholder");
    await expectStill(room, "room window");
    await expectNamed(a.page, "room placeholder");
    await expectNamed(room, "room window");
  });

  test("the report dialog opens and sends without motion; its keys are named", async ({ browser }) => {
    const page = await first(browser, testRoom("m7-a11y", "send"), reduced(), async (context) => {
      await watched(context);
      await mockReport(context);
    });
    await openReport(page);
    await expectStill(page, "report dialog open");
    await expectNamed(page, "report dialog");
    await page.keyboard.press("Space");
    await page.locator(site.reportSend).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(site.reportSent)).toBeVisible();
    await expectStill(page, "report sent");
    await expectNamed(page, "report sent");
    await page.keyboard.press("Enter");
    await expect(page.locator(site.reportDialog)).toBeHidden();
    await expectStill(page, "report closed");
  });

  test("the quality menu's keys are named and it opens without motion", async ({ browser, request }) => {
    const room = testRoom("m7-a11y", "qreduced");
    await shareProvider(request, providerCase("twitchVod").shareUrl, room.id);
    const [a] = await join(browser, room, 1, reduced(), async (context) => {
      await watched(context);
    });
    if (a === undefined) throw new Error("no client");
    await waitProviderPlaying([a], "twitch");
    await a.page.locator('[data-testid="quality-key"]').focus();
    await a.page.keyboard.press("Enter");
    await expect(a.page.locator('[data-testid="quality-menu"]')).toBeVisible();
    await expectStill(a.page, "quality menu");
    await expectNamed(a.page, "quality menu");
  });
});
