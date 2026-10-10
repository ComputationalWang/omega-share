// OME-733 (M8 Q1): QA coverage of set (l)'s emote wheel (OME-732: T opens a radial role=menu over your own head). The wheel's
// happy path lives in emotes.e2e.ts ("the wheel"); this spec covers what it leaves out, in a room of its own per test
// (support/test-rooms.ts, "m8-wheel"):
//  1. Guards: T is text in the chat input and any other field, does nothing under a modal dialog or IME composition, and
//     with Alt, Ctrl, Meta or Shift held it isn't the wheel's key.
//  2. A mouse pick: the wheel key opens it, a click on a slot sends, it closes, focus goes back to the key.
//  3. Closing: Esc, T and the key close and give focus back to the opener; a click elsewhere closes; Tab closes;
//     the arrows wrap and Home/End go to the ends.
//  4. Cooling: after a burst the slots are aria-disabled with the dial, a pick sends nothing and the wheel stays; it warms.
//  5. Accessibility: a keyboard-only walk (join, sit, chat, wheel) with a visible focus at every stop, axe on the open
//     wheel, the menu/menuitem names, and under reduced motion nothing animates longer than a blink and the sticker is
//     the still badge.
import AxeBuilder from "@axe-core/playwright";
import * as v from "valibot";
import type { Browser, Locator, Page } from "@playwright/test";
import { expect, test, watchCsp } from "./support/csp";
import { PENDING, available } from "./support/apps";
import { stubExternalNetwork } from "./support/network";
import { joinRoom, leaveAll, testRoom, type Client } from "./support/room";
import { site } from "./support/selectors";
import type { RoomName } from "./support/test-rooms";

test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);
test.setTimeout(90_000);

let clients: Client[] = [];
test.afterEach(async () => {
  await leaveAll(clients);
  clients = [];
});

const REDUCED = { reducedMotion: "reduce" } as const;

/** My member id from the dev handle (apps/web/src/main.ts `window.__omega.room`). */
async function self(page: Page): Promise<string> {
  const id = await page.evaluate(() => {
    const debug: unknown = Reflect.get(window, "__omega");
    const room: unknown = typeof debug === "object" && debug !== null ? Reflect.get(debug, "room") : null;
    const state: unknown = typeof room === "object" && room !== null ? Reflect.get(room, "state") : null;
    const s: unknown = typeof state === "function" ? Reflect.apply(state, room, []) : null;
    return typeof s === "object" && s !== null ? (Reflect.get(s, "self") as unknown) : null;
  });
  return v.parse(v.string(), id);
}

const mySeat = async (page: Page): Promise<number> =>
  v.parse(
    v.number(),
    await page.evaluate(() => {
      const debug: unknown = Reflect.get(window, "__omega");
      const room: unknown = typeof debug === "object" && debug !== null ? Reflect.get(debug, "room") : null;
      const f: unknown = typeof room === "object" && room !== null ? Reflect.get(room, "state") : null;
      const s: unknown = typeof f === "function" ? Reflect.apply(f, room, []) : null;
      if (typeof s !== "object" || s === null) return -1;
      const me: unknown = Reflect.get(s, "self");
      const r: unknown = Reflect.get(s, "room");
      const seats: unknown = typeof r === "object" && r !== null ? Reflect.get(r, "seats") : null;
      return Array.isArray(seats) ? seats.indexOf(me) : -1;
    }),
  );

/** The frame name my avatar (or someone's) is drawn with now, from the dev handle (`room.avatarFrames`). */
const avatarFrame = async (page: Page, id: string): Promise<string> =>
  v.parse(
    v.string(),
    await page.evaluate((who) => {
      const debug: unknown = Reflect.get(window, "__omega");
      const room: unknown = typeof debug === "object" && debug !== null ? Reflect.get(debug, "room") : null;
      const get: unknown = typeof room === "object" && room !== null ? Reflect.get(room, "avatarFrames") : null;
      const f: unknown = typeof get === "function" ? Reflect.apply(get, room, [who]) : null;
      const a: unknown = typeof f === "object" && f !== null ? Reflect.get(f, "avatar") : null;
      return typeof a === "string" ? a : "";
    }, id),
  );

type Name = RoomName<"m8-wheel">;

/** One client in the test's own room, or two; `reduced[i]` gives client i reduced motion (so each sticker it sees leaves a badge to count). */
async function enter(browser: Browser, name: Name, count: 1 | 2 = 1, reduced: readonly boolean[] = []): Promise<{ a: Client; b: Client; aId: string }> {
  clients = await joinRoom(browser, {
    roomUrl: testRoom("m8-wheel", name).url,
    count,
    nicknamePrefix: "wh",
    contextOptions: (i) => (reduced[i] === true ? REDUCED : undefined),
  });
  const [a, b] = clients;
  if (a === undefined) throw new Error("no client");
  return { a, b: b ?? a, aId: await self(a.page) };
}

/** Records every emote badge that appears on a page (each sticker received is one) into `window.__badges`. */
async function countBadges(page: Page): Promise<void> {
  await page.evaluate(() => {
    const seen: { kind: string; member: string }[] = [];
    Reflect.set(window, "__badges", seen);
    new MutationObserver((records) => {
      for (const r of records)
        for (const n of r.addedNodes)
          if (n instanceof HTMLElement && n.dataset["testid"] === "emote-badge") seen.push({ kind: n.className.replace(/^.*ui-emote-pick-(\w+).*$/, "$1"), member: n.dataset["member"] ?? "" });
    }).observe(document.body, { childList: true, subtree: true });
  });
}

const Badges = v.array(v.object({ kind: v.string(), member: v.string() }));
const badges = async (page: Page): Promise<v.InferOutput<typeof Badges>> => v.parse(Badges, await page.evaluate(() => Reflect.get(window, "__badges") as unknown));

const wheelOf = (page: Page): Locator => page.getByRole("menu", { name: "Emotes" });
const keyOf = (page: Page): Locator => page.getByTestId("emote-key");
const bodyFocused = (page: Page): Promise<boolean> => page.evaluate(() => document.activeElement === document.body);
const focusedId = (page: Page): Promise<string> => page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? document.activeElement?.tagName ?? "none");
const body = (page: Page): Promise<void> => page.locator("body").click({ position: { x: 2, y: 2 } });

// --- 1. guards ------------------------------------------------------------------------------------------------------

test.describe("T does not open the wheel", () => {
  test("in the chat input: it types a t", async ({ browser }) => {
    const { a } = await enter(browser, "gchat");
    await a.page.locator(site.chatInput).fill("");
    await a.page.locator(site.chatInput).focus();
    await a.page.keyboard.press("t");
    await a.page.keyboard.press("Shift+T");
    await expect(a.page.locator(site.chatInput)).toHaveValue("tT");
    await expect(wheelOf(a.page)).toBeHidden();
    await expect(keyOf(a.page)).toHaveAttribute("aria-expanded", "false");
  });

  test("in the queue's paste field (any other text field)", async ({ browser }) => {
    const { a } = await enter(browser, "gfield");
    const field = a.page.locator(site.queueUrl);
    await field.scrollIntoViewIfNeeded();
    await field.focus();
    await a.page.keyboard.type("t1");
    await expect(field).toHaveValue("t1");
    await expect(wheelOf(a.page)).toBeHidden();
    // ...and the 1 is not swallowed as an emote either.
    await expect(a.page.getByTestId("emote-badge")).toHaveCount(0);
  });

  test("while a dialog is open (the report dialog, then any <dialog>)", async ({ browser }) => {
    const { a } = await enter(browser, "gdialog");
    await a.page.locator(site.reportKey).focus();
    await a.page.keyboard.press("Enter");
    await expect(a.page.locator(site.reportDialog)).toBeVisible();
    await a.page.keyboard.press("t");
    await expect(wheelOf(a.page)).toBeHidden();
    await expect(keyOf(a.page)).toHaveAttribute("aria-expanded", "false");
    await a.page.keyboard.press("Escape");
    await expect(a.page.locator(site.reportDialog)).toBeHidden();
    // A dialog that isn't the report's: the guard is "any open <dialog>".
    await a.page.evaluate(() => {
      const d = document.createElement("dialog");
      d.id = "qa-dialog";
      d.textContent = "qa";
      document.body.append(d);
      d.show();
    });
    await body(a.page);
    await a.page.keyboard.press("t");
    await expect(wheelOf(a.page)).toBeHidden();
    await a.page.evaluate(() => document.querySelector("dialog#qa-dialog")?.remove());
    await a.page.keyboard.press("t");
    await expect(wheelOf(a.page)).toBeVisible();
  });

  test("during IME composition", async ({ browser }) => {
    const { a } = await enter(browser, "gime");
    await body(a.page);
    // A composing keydown: the browser reports key "t" with isComposing (and keyCode 229) while an IME owns the keystroke.
    await a.page.evaluate(() => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "t", code: "KeyT", keyCode: 229, bubbles: true, cancelable: true, isComposing: true }));
    });
    await a.page.waitForTimeout(200);
    await expect(wheelOf(a.page)).toBeHidden();
    // A composing digit is no emote either.
    await a.page.evaluate(() => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "3", code: "Digit3", bubbles: true, cancelable: true, isComposing: true }));
    });
    await a.page.waitForTimeout(200);
    await expect(a.page.getByTestId("emote-badge")).toHaveCount(0);
    // The same keydown without a composition is the wheel's.
    await a.page.evaluate(() => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "t", code: "KeyT", bubbles: true, cancelable: true }));
    });
    await expect(wheelOf(a.page)).toBeVisible();
  });

  test("with Alt, Ctrl, Meta or Shift held (not the wheel's key)", async ({ browser }) => {
    const { a } = await enter(browser, "gmods");
    await body(a.page);
    for (const combo of ["Alt+t", "Control+t", "Meta+t", "Shift+T"]) {
      await a.page.keyboard.press(combo);
      await a.page.waitForTimeout(100);
      await expect(wheelOf(a.page), combo).toBeHidden();
    }
    // A plain t still opens it, so the guard is the modifier and not a dead key.
    await a.page.keyboard.press("t");
    await expect(wheelOf(a.page)).toBeVisible();
    // Open: Alt+T is still not T, so it does not close it.
    await a.page.keyboard.press("Alt+t");
    await expect(wheelOf(a.page)).toBeVisible();
  });
});

// --- 2. mouse pick --------------------------------------------------------------------------------------------------

test("a mouse pick: the key opens the wheel, a click on a sticker sends it for everyone, the wheel closes, focus is on the key", async ({ browser }) => {
  const { a, b, aId } = await enter(browser, "pick", 2, [false, true]);
  await countBadges(b.page);
  const key = keyOf(a.page);
  await key.click();
  await expect(wheelOf(a.page)).toBeVisible();
  await expect(key).toHaveAttribute("aria-expanded", "true");
  // Hovering previews in the hub; the selection (and focus) stays on the first slot.
  await a.page.getByRole("menuitem", { name: "Clap" }).hover();
  await expect(wheelOf(a.page).locator(".ui-wheel-hub .ui-emote-pick-clap")).toHaveCount(1);
  await a.page.getByRole("menuitem", { name: "Clap" }).click();
  await expect(wheelOf(a.page)).toBeHidden();
  await expect(key).toBeFocused();
  await expect(key).toHaveAttribute("aria-expanded", "false");
  await expect.poll(() => badges(b.page), { timeout: 3000 }).toEqual([{ kind: "clap", member: aId }]);
  // Nothing was sent twice.
  await a.page.waitForTimeout(400);
  expect(await badges(b.page)).toHaveLength(1);
});

// --- 3. closing -----------------------------------------------------------------------------------------------------

test.describe("closing the wheel", () => {
  test("Esc, T and the key close it and focus goes back to the opener", async ({ browser }) => {
    const { a } = await enter(browser, "close");
    const wheel = wheelOf(a.page);
    const key = keyOf(a.page);
    // From <body>: back on <body>.
    await body(a.page);
    await a.page.keyboard.press("t");
    await expect(wheel).toBeVisible();
    await a.page.keyboard.press("Escape");
    await expect(wheel).toBeHidden();
    expect(await bodyFocused(a.page)).toBe(true);
    await a.page.keyboard.press("t");
    await expect(wheel).toBeVisible();
    await a.page.keyboard.press("t");
    await expect(wheel).toBeHidden();
    expect(await bodyFocused(a.page)).toBe(true);
    // From a seat: back on the seat.
    await a.page.locator(site.seat).first().focus();
    await a.page.keyboard.press("t");
    await expect(wheel).toBeVisible();
    await expect(a.page.getByRole("menuitem", { name: "Heart" })).toBeFocused();
    await a.page.keyboard.press("Escape");
    await expect(wheel).toBeHidden();
    expect(await focusedId(a.page)).toBe("seat");
    await a.page.keyboard.press("t");
    await expect(wheel).toBeVisible();
    await a.page.keyboard.press("t");
    await expect(wheel).toBeHidden();
    expect(await focusedId(a.page)).toBe("seat");
    // From the wheel key: back on the key, closed by Esc, by T and by the key again.
    await key.focus();
    await a.page.keyboard.press("Enter");
    await expect(wheel).toBeVisible();
    await a.page.keyboard.press("Escape");
    await expect(wheel).toBeHidden();
    await expect(key).toBeFocused();
    await key.click();
    await expect(wheel).toBeVisible();
    await a.page.keyboard.press("t");
    await expect(wheel).toBeHidden();
    await expect(key).toBeFocused();
    await key.click();
    await expect(wheel).toBeVisible();
    await key.click({ force: true });
    await expect(wheel).toBeHidden();
  });

  test("a click elsewhere closes it; Tab closes it and moves on", async ({ browser }) => {
    const { a } = await enter(browser, "outside");
    const wheel = wheelOf(a.page);
    await keyOf(a.page).click();
    await expect(wheel).toBeVisible();
    await body(a.page);
    await expect(wheel).toBeHidden();
    await expect(keyOf(a.page)).toHaveAttribute("aria-expanded", "false");
    await a.page.keyboard.press("t");
    await expect(wheel).toBeVisible();
    await a.page.keyboard.press("Tab");
    await expect(wheel).toBeHidden();
    // Focus went on somewhere real, not lost on the hidden slot.
    expect(await a.page.evaluate(() => document.activeElement?.closest("[role=menu]") ?? null)).toBeNull();
  });

  test("the arrows rove and wrap, Home and End go to the ends", async ({ browser }) => {
    const { a } = await enter(browser, "keys");
    await body(a.page);
    await a.page.keyboard.press("t");
    const item = (name: string): Locator => a.page.getByRole("menuitem", { name });
    await expect(item("Heart")).toBeFocused();
    await a.page.keyboard.press("End");
    await expect(item("Wave")).toBeFocused();
    await a.page.keyboard.press("ArrowRight");
    await expect(item("Heart")).toBeFocused();
    await a.page.keyboard.press("ArrowLeft");
    await expect(item("Wave")).toBeFocused();
    await a.page.keyboard.press("Home");
    await expect(item("Heart")).toBeFocused();
    await a.page.keyboard.press("ArrowUp");
    await expect(item("Wave")).toBeFocused();
    await a.page.keyboard.press("ArrowDown");
    await expect(item("Heart")).toBeFocused();
    await a.page.keyboard.press("ArrowDown");
    await expect(item("Laugh")).toBeFocused();
    // Roving tabindex: one stop in the menu, the selected one.
    const stops = await a.page.locator("[role=menuitem]").evaluateAll((els) => els.map((e) => e.getAttribute("tabindex")));
    expect(stops).toEqual(["-1", "0", "-1", "-1", "-1", "-1"]);
  });
});

// --- 4. cooling -----------------------------------------------------------------------------------------------------

/** Stops `performance.now` in the page (`on`), or lets it run again at the real time (`off`). */
const holdClock = (page: Page, on: boolean): Promise<void> =>
  page.evaluate((hold) => {
    const real: unknown = Reflect.get(window, "__realNow");
    const now = typeof real === "function" ? (real as () => number) : performance.now.bind(performance);
    Reflect.set(window, "__realNow", now);
    const at = now();
    performance.now = hold ? () => at : now;
  }, on);

test("cooling: after a burst the slots are disabled and show the dial, a pick sends nothing and the wheel stays; it warms again", async ({ browser }) => {
  const { a, b } = await enter(browser, "cool", 2, [false, true]);
  await countBadges(b.page);
  const wheel = wheelOf(a.page);
  await body(a.page);
  // The key warms one second after the burst (a token a second): on a busy box the checks below took longer than that
  // and saw it warm (OME-879). So a's performance.now, which the picker's bucket counts on, stands still from the burst
  // until the warm-up check; rAF and timers keep running (page.clock would stall rAF), the server's limit keeps real time.
  await holdClock(a.page, true);
  // A burst through the wheel: T, Enter, until the key cools (the burst is three, a token comes back each second).
  for (let i = 0; i < 6 && !(await keyOf(a.page).evaluate((e) => e.classList.contains("is-cooling"))); i++) {
    await a.page.keyboard.press("t");
    await expect(wheel).toBeVisible();
    await a.page.keyboard.press("Enter");
    await expect(wheel).toBeHidden();
  }
  await expect(keyOf(a.page)).toHaveClass(/is-cooling/);
  await expect(keyOf(a.page)).toHaveAttribute("aria-disabled", "true");
  await expect.poll(async () => (await badges(b.page)).length, { timeout: 3000 }).toBeGreaterThanOrEqual(3);
  const sent = (await badges(b.page)).length;
  // Open it while cooling: every slot is aria-disabled, the hub is the dial and the chip says when.
  await a.page.keyboard.press("t");
  await expect(wheel).toBeVisible();
  const slots = wheel.getByRole("menuitem");
  await expect(slots).toHaveCount(6);
  for (const s of await slots.all()) await expect(s).toHaveAttribute("aria-disabled", "true");
  await expect(wheel.locator(".ui-wheel-hub .ui-wait")).toHaveCount(1);
  await expect(wheel.locator(".ui-wheel-label")).toHaveText(/Emotes in \d+ s/);
  // A pick (key and mouse) sends nothing and the wheel stays open.
  await a.page.keyboard.press("Enter");
  await a.page.getByRole("menuitem", { name: "Clap" }).click({ force: true });
  await a.page.waitForTimeout(150);
  await expect(wheel).toBeVisible();
  expect((await badges(b.page)).length).toBe(sent);
  // It warms: the slots enable, the key stops cooling, and the next pick goes out. A real second first, so the server's
  // bucket has a token for it too.
  await a.page.waitForTimeout(1000);
  await holdClock(a.page, false);
  await expect(keyOf(a.page)).not.toHaveClass(/is-cooling/, { timeout: 3000 });
  for (const s of await slots.all()) await expect(s).toHaveAttribute("aria-disabled", "false");
  await a.page.getByRole("menuitem", { name: "Wave" }).click();
  await expect(wheel).toBeHidden();
  await expect.poll(async () => (await badges(b.page)).length, { timeout: 3000 }).toBe(sent + 1);
  expect((await badges(b.page)).at(-1)?.kind).toBe("wave");
});

// --- 5. accessibility -----------------------------------------------------------------------------------------------

interface Stop {
  readonly what: string;
  readonly visible: boolean;
  readonly focusVisible: boolean;
  readonly indicator: boolean;
}

/**
 * Where focus is and whether it shows: an outline or box-shadow (m7-a11y.e2e.ts's check), or, for a wheel slot, the focused
 * slot's sprite swapped for the lit one (the wheel paints its selection by background-position and has no outline).
 */
const stopOf = (page: Page): Promise<Stop> =>
  page.evaluate((): Stop => {
    const el = document.activeElement;
    if (el === null || el === document.body || el === document.documentElement) return { what: "body", visible: false, focusVisible: false, indicator: false };
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const what = el.getAttribute("data-testid") ?? `${el.tagName.toLowerCase()}${el.id === "" ? "" : `#${el.id}`}`;
    let lit = false;
    if (el.classList.contains("ui-wheel-slot")) {
      const other = [...document.querySelectorAll(".ui-wheel-slot")].find((s) => s !== el);
      lit = other !== undefined && getComputedStyle(other).backgroundPosition !== cs.backgroundPosition;
    }
    return {
      what,
      visible: r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && el.getClientRects().length > 0,
      focusVisible: el.matches(":focus-visible"),
      indicator: (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== "none" || lit,
    };
  });

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
  else if (!s.indicator) problems.push(`${step}: ${s.what} has no visible focus indicator (no outline, no box-shadow, no lit sprite)`);
  return s.what;
}

async function tabTo(page: Page, testId: string, step: string, problems: string[], max = 60): Promise<void> {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press("Tab");
    if ((await checkFocus(page, `${step} (stop ${String(i + 1)})`, problems, true)) === testId) return;
  }
  throw new Error(`${step}: ${testId} not reached in ${String(max)} Tab presses`);
}

test("keyboard only, no mouse: join, sit, chat, then the wheel by T and by its key; focus is visible and never on <body>", async ({ browser }) => {
  const room = testRoom("m8-wheel", "walk");
  const problems: string[] = [];
  // A second member watches (joined the usual way; reduced motion so each sticker leaves a badge to count).
  clients = await joinRoom(browser, { roomUrl: room.url, count: 1, nicknamePrefix: "whb", contextOptions: () => REDUCED });
  const b = clients[0];
  if (b === undefined) throw new Error("no helper");
  await countBadges(b.page);
  const context = await watchCsp(await browser.newContext());
  await stubExternalNetwork(context);
  try {
    const page = await context.newPage();
    await page.goto(room.url);
    await tabTo(page, "nickname-input", "land", problems);
    await page.keyboard.type("whkeys");
    await tabTo(page, "avatar-option", "avatar", problems);
    await tabTo(page, "join-button", "join", problems);
    await page.keyboard.press("Enter");
    await expect(page.locator(site.room)).toBeVisible();
    await checkFocus(page, "after joining", problems);
    const aId = await self(page);

    await tabTo(page, "seat", "to a seat", problems);
    await page.keyboard.press("Enter");
    await expect.poll(() => mySeat(page)).toBeGreaterThanOrEqual(0);
    await checkFocus(page, "after sitting", problems);
    // The walk to the seat is over (a wheel opened mid-walk would close: the avatar is moving).
    await expect.poll(() => avatarFrame(page, aId), { timeout: 15_000 }).toMatch(/^(breathe\/)?\w+\/sit\//);

    // Chat: Enter jumps to the field, type (a t is text there), Enter sends; Esc hands the keys back.
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    });
    await page.keyboard.press("Enter");
    await expect(page.locator(site.chatInput)).toBeFocused();
    await checkFocus(page, "chat field", problems);
    await page.keyboard.type("t is for text here");
    await page.keyboard.press("Enter");
    await expect(page.locator(site.chatInput)).toHaveValue("");
    await expect(wheelOf(page)).toBeHidden();
    await page.keyboard.press("Escape");

    // The wheel by T from the wheel's own key (focus is on a real element, so it comes back there).
    await tabTo(page, "emote-key", "to the wheel key", problems, 80);
    await expect(keyOf(page)).toHaveAttribute("aria-haspopup", "menu");
    await page.keyboard.press("t");
    await expect(wheelOf(page)).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Heart" })).toBeFocused();
    await checkFocus(page, "wheel opened by T", problems);
    await page.keyboard.press("ArrowRight");
    await checkFocus(page, "wheel, arrow", problems);
    await expect(page.getByRole("menuitem", { name: "Laugh" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(wheelOf(page)).toBeHidden();
    await expect(keyOf(page)).toBeFocused();
    await checkFocus(page, "after the pick", problems);
    await expect.poll(() => badges(b.page), { timeout: 3000 }).toEqual([{ kind: "laugh", member: aId }]);

    // ...and by Enter on the key itself, closed by Esc.
    await page.keyboard.press("Enter");
    await expect(wheelOf(page)).toBeVisible();
    await checkFocus(page, "wheel opened by its key", problems);
    await page.keyboard.press("End");
    await checkFocus(page, "wheel, End", problems);
    await page.keyboard.press("Escape");
    await expect(wheelOf(page)).toBeHidden();
    await expect(keyOf(page)).toBeFocused();
    await checkFocus(page, "after Esc", problems);
    expect(problems).toEqual([]);
  } finally {
    await context.close();
  }
});

test("the open wheel has no axe violations (wcag2a/aa); it is a menu named Emotes of six named menuitems", async ({ browser }) => {
  const { a } = await enter(browser, "axe");
  await body(a.page);
  await a.page.keyboard.press("t");
  const wheel = wheelOf(a.page);
  await expect(wheel).toBeVisible();
  await expect(wheel).toHaveAccessibleName("Emotes");
  const items = wheel.getByRole("menuitem");
  await expect(items).toHaveCount(6);
  const names = ["Heart", "Laugh", "Question", "Surprise", "Clap", "Wave"];
  for (const [i, item] of (await items.all()).entries()) {
    await expect(item).toHaveAccessibleName(names[i] ?? "?");
    await expect(item).toHaveAttribute("aria-keyshortcuts", String(i + 1));
  }
  const result = await new AxeBuilder({ page: a.page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).include(".emote-picker").exclude("iframe").analyze();
  expect(result.violations.map((x) => `${x.id}: ${x.help} | ${x.nodes.map((n) => n.target.join(" ")).join(" ; ")}`)).toEqual([]);
  expect(result.passes.length).toBeGreaterThan(0);
  // The hub and the chip repeat the selection for the eye only: out of the accessibility tree.
  await expect(wheel.locator(".ui-wheel-hub")).toHaveAttribute("aria-hidden", "true");
  await expect(wheel.locator(".ui-wheel-label")).toHaveAttribute("aria-hidden", "true");
});

test("prefers-reduced-motion: the wheel opens and closes with nothing animating longer than a blink, and the sticker is the still badge", async ({ browser }) => {
  clients = await joinRoom(browser, {
    roomUrl: testRoom("m8-wheel", "reduced").url,
    count: 2,
    nicknamePrefix: "wh",
    contextOptions: () => REDUCED,
    setup: async (context) => {
      await context.addInitScript(() => {
        const seen: { what: string; ms: number }[] = [];
        Reflect.set(window, "__motion", seen);
        const note = (): void => {
          for (const x of document.getAnimations()) {
            if (!(x instanceof CSSAnimation || x instanceof CSSTransition)) continue;
            const t = x.effect;
            const target = t instanceof KeyframeEffect ? t.target : null;
            const where = target instanceof Element ? (target.getAttribute("data-testid") ?? target.getAttribute("class") ?? target.tagName) : "?";
            seen.push({ what: `${x instanceof CSSAnimation ? x.animationName : x.transitionProperty} on ${where}`, ms: t === null ? 0 : Number(t.getComputedTiming().endTime) });
          }
        };
        document.addEventListener("animationstart", () => setTimeout(note, 0), true);
        document.addEventListener("transitionrun", () => setTimeout(note, 0), true);
      });
    },
  });
  const [a, b] = clients;
  if (a === undefined || b === undefined) throw new Error("need two clients");
  const aId = await self(a.page);
  await countBadges(b.page);
  const wheel = wheelOf(a.page);
  await body(a.page);
  await a.page.keyboard.press("t");
  await expect(wheel).toBeVisible();
  // Sample the computed opacity and transform through the first moments: it is there whole at once, never mid-fade.
  const samples = v.parse(
    v.array(v.object({ opacity: v.string(), transform: v.string(), animation: v.string() })),
    await wheel.evaluate(async (e) => {
      const out: { opacity: string; transform: string; animation: string }[] = [];
      for (let i = 0; i < 12; i++) {
        const cs = getComputedStyle(e);
        out.push({ opacity: cs.opacity, transform: cs.transform, animation: cs.animationName });
        await new Promise((r) => setTimeout(r, 25));
      }
      return out;
    }),
  );
  expect(new Set(samples.map((s) => s.opacity))).toEqual(new Set(["1"]));
  expect(new Set(samples.map((s) => s.transform)).size).toBe(1);
  expect(new Set(samples.map((s) => s.animation))).toEqual(new Set(["none"]));
  await a.page.keyboard.press("ArrowRight");
  await a.page.keyboard.press("Enter");
  await expect(wheel).toBeHidden();
  // The sticker is a still badge on both pages, not frames.
  for (const p of [a.page, b.page]) {
    const badge = p.getByTestId("emote-badge");
    await expect(badge).toHaveCount(1);
    await expect(badge).toHaveClass(/ui-emote-pick-laugh/);
  }
  expect(await badges(b.page)).toEqual([{ kind: "laugh", member: aId }]);
  await a.page.keyboard.press("t");
  await expect(wheel).toBeVisible();
  await a.page.keyboard.press("Escape");
  await expect(wheel).toBeHidden();
  await a.page.waitForTimeout(200);
  const Motion = v.array(v.object({ what: v.string(), ms: v.number() }));
  for (const p of [a.page, b.page]) {
    const seen = v.parse(Motion, await p.evaluate(() => Reflect.get(window, "__motion") as unknown));
    const live = v.parse(
      Motion,
      await p.evaluate(() =>
        document
          .getAnimations()
          .filter((x) => x instanceof CSSAnimation || x instanceof CSSTransition)
          .map((x) => ({ what: `running ${x instanceof CSSAnimation ? x.animationName : x.transitionProperty}`, ms: Number(x.effect?.getComputedTiming().endTime ?? 0) })),
      ),
    );
    // The badge's own life is a timer, not CSS; the reduced chat/float fade (opacity only) is the one allowed long animation.
    const long = [...seen, ...live].filter((m) => m.ms > 20 && !m.what.includes("ui-float-life-reduced"));
    expect(long, "CSS motion under reduced motion").toEqual([]);
  }
});
