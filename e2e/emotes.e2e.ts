// Emotes (OME-415): the picker and keys 1–6 send `emote`; every client plays `emoted` once over the sender's avatar
// (a wave in the avatar's own frames, idle or seated). Under prefers-reduced-motion it's a static badge instead.
import * as v from "valibot";
import { expect, test } from "./support/csp";
import type { Page } from "@playwright/test";
import { PENDING, available } from "./support/apps";
import { joinRoom, leaveAll, testRoom, type Client } from "./support/room";
import { site } from "./support/selectors";

test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);

let clients: Client[] = [];
test.afterEach(async () => {
  await leaveAll(clients);
  clients = [];
});

const Frames = v.nullable(v.object({ avatar: v.nullable(v.string()), sticker: v.nullable(v.string()) }));

/** The dev handle (apps/web/src/main.ts `window.__omega.room`): my member id, or someone's frames now. */
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

async function frames(page: Page, id: string): Promise<v.InferOutput<typeof Frames>> {
  const f = await page.evaluate((id) => {
    const debug: unknown = Reflect.get(window, "__omega");
    const room: unknown = typeof debug === "object" && debug !== null ? Reflect.get(debug, "room") : null;
    const get: unknown = typeof room === "object" && room !== null ? Reflect.get(room, "avatarFrames") : null;
    return typeof get === "function" ? ((Reflect.apply(get, room, [id]) as unknown) ?? null) : null;
  }, id);
  return v.parse(Frames, f);
}

test.describe("emotes", () => {
  /** Two clients in the test's own room, both drawn with the motion atlas (b walked in and is at rest). */
  async function pair(browser: Parameters<typeof joinRoom>[0], prefix: "sticker" | "waver" | "typist" | "burst" | "still" | "wheel" | "wheelwalk") {
    clients = await joinRoom(browser, { roomUrl: testRoom("emotes", prefix).url, count: 2, nicknamePrefix: prefix });
    const [a, b] = clients;
    if (a === undefined || b === undefined) throw new Error("need two clients");
    const aId = await self(a.page);
    const bId = await self(b.page);
    // The atlas is in and b's walk in from the door is over: b is drawn with a set (a) idle frame.
    await expect.poll(async () => (await frames(a.page, bId))?.avatar ?? "", { timeout: 15_000 }).toMatch(/^(breathe\/)?\w+\/idle\//);
    return { a, b, aId, bId };
  }

  test("a sticker from the picker plays over the sender's avatar for everyone, then goes", async ({ browser }) => {
    const { a, b, aId } = await pair(browser, "sticker");
    await a.page.getByTestId("emote-key").click();
    await expect(a.page.getByTestId("emote-menu")).toBeVisible();
    await a.page.getByRole("menuitem", { name: "Heart" }).click();
    await expect(a.page.getByTestId("emote-menu")).toBeHidden();
    for (const page of [a.page, b.page]) {
      await expect.poll(async () => (await frames(page, aId))?.sticker ?? "", { timeout: 3000, intervals: [50] }).toMatch(/^emote\/heart\/[0-2]$/);
    }
    await expect.poll(async () => (await frames(b.page, aId))?.sticker ?? "gone", { timeout: 3000 }).toBe("gone");
  });

  test("key 6 waves: standing in the idle pose, seated in the sit pose", async ({ browser }) => {
    const { a, b, bId } = await pair(browser, "waver");
    await b.page.locator("body").click({ position: { x: 2, y: 2 } });
    await b.page.keyboard.press("6");
    await expect.poll(async () => (await frames(a.page, bId))?.avatar ?? "", { timeout: 3000, intervals: [40] }).toMatch(/^wave\/\w+\/idle\//);
    await b.page.locator(`${site.seat}[data-seat="0"]`).click();
    await expect.poll(async () => (await frames(a.page, bId))?.avatar ?? "", { timeout: 15_000 }).toMatch(/^(breathe\/)?\w+\/sit\//);
    await b.page.locator("body").click({ position: { x: 2, y: 2 } });
    await b.page.keyboard.press("6");
    await expect.poll(async () => (await frames(a.page, bId))?.avatar ?? "", { timeout: 3000, intervals: [40] }).toMatch(/^wave\/\w+\/sit\//);
  });

  test("digits typed into chat are chat, not emotes", async ({ browser }) => {
    const { a, b, aId } = await pair(browser, "typist");
    await a.page.locator(site.chatInput).fill("");
    await a.page.locator(site.chatInput).pressSequentially("123");
    await expect(a.page.locator(site.chatInput)).toHaveValue("123");
    await b.page.waitForTimeout(500);
    expect((await frames(b.page, aId))?.sticker ?? null).toBeNull();
  });

  test("a burst cools the key before the server would drop one; it warms again; chat never cools", async ({ browser }) => {
    const { a } = await pair(browser, "burst");
    await a.page.locator("body").click({ position: { x: 2, y: 2 } });
    for (const k of ["1", "2", "3", "4", "5"]) await a.page.keyboard.press(k);
    await expect(a.page.getByTestId("emote-key")).toHaveClass(/is-cooling/);
    await expect(a.page.locator(site.roomNotice)).toBeHidden();
    await expect(a.page.locator(site.chatSend)).toBeEnabled();
    await expect(a.page.getByTestId("emote-key")).not.toHaveClass(/is-cooling/, { timeout: 3000 });
  });

  test("prefers-reduced-motion: a still badge over the avatar, no sticker frames", async ({ browser }) => {
    const { a, b, aId } = await pair(browser, "still");
    await b.page.emulateMedia({ reducedMotion: "reduce" });
    await a.page.locator("body").click({ position: { x: 2, y: 2 } });
    await a.page.keyboard.press("2");
    const badge = b.page.getByTestId("emote-badge");
    await expect(badge).toHaveCount(1);
    await expect(badge).toHaveClass(/ui-emote-pick-laugh/);
    expect((await frames(b.page, aId))?.sticker ?? null).toBeNull();
    await expect(badge).toHaveCount(0, { timeout: 3000 });
  });

  // OME-732 (M8 W3): set (l)'s emote wheel. T (or the wheel key by the chat input) opens it over your own head.
  test.describe("the wheel", () => {
    const roomRenders = async (page: Page): Promise<number> =>
      v.parse(
        v.number(),
        await page.evaluate(() => {
          const debug: unknown = Reflect.get(window, "__omega");
          const room: unknown = typeof debug === "object" && debug !== null ? Reflect.get(debug, "room") : null;
          const get: unknown = typeof room === "object" && room !== null ? Reflect.get(room, "roomRenders") : null;
          return typeof get === "function" ? (Reflect.apply(get, room, []) as unknown) : null;
        }),
      );

    test("T opens it over your own avatar; arrows pick, Enter sends for everyone, focus goes back", async ({ browser }) => {
      const { a, b, aId } = await pair(browser, "wheel");
      await a.page.locator("body").click({ position: { x: 2, y: 2 } });
      await a.page.keyboard.press("t");
      const wheel = a.page.getByRole("menu", { name: "Emotes" });
      await expect(wheel).toBeVisible();
      await expect(a.page.getByRole("menuitem", { name: "Heart" })).toBeFocused();
      await expect(a.page.getByTestId("emote-key")).toHaveAttribute("aria-expanded", "true");
      // Over my head: centred on my name tag (which hangs under my feet), wholly above it, with its tail.
      const box = await wheel.boundingBox();
      const tag = await a.page.getByTestId("nickname-tag").filter({ hasText: "wheel-1" }).boundingBox();
      if (box === null || tag === null) throw new Error("no wheel or tag box");
      expect(Math.abs(box.x + box.width / 2 - (tag.x + tag.width / 2))).toBeLessThanOrEqual(4);
      expect(box.y + box.height).toBeLessThan(tag.y);
      await expect(wheel).not.toHaveClass(/no-tail/);
      await a.page.keyboard.press("ArrowRight");
      await expect(a.page.getByRole("menuitem", { name: "Laugh" })).toBeFocused();
      await a.page.keyboard.press("Enter");
      await expect(wheel).toBeHidden();
      await expect.poll(() => a.page.evaluate(() => document.activeElement === document.body)).toBe(true);
      await expect.poll(async () => (await frames(b.page, aId))?.sticker ?? "", { timeout: 3000, intervals: [50] }).toMatch(/^emote\/laugh\/[0-2]$/);
      // Esc closes it too.
      await a.page.keyboard.press("t");
      await expect(wheel).toBeVisible();
      await a.page.keyboard.press("Escape");
      await expect(wheel).toBeHidden();
    });

    test("opening it draws nothing on the room canvas and adds no long task", async ({ browser }) => {
      // Reduced motion: an avatar at rest doesn't breathe, so any render after the room settles would be the wheel's.
      clients = await joinRoom(browser, { roomUrl: testRoom("emotes", "wheelcost").url, count: 1, nicknamePrefix: "wheelcost", contextOptions: () => ({ reducedMotion: "reduce" }) });
      const page = clients[0]?.page;
      if (page === undefined) throw new Error("no client");
      await page.evaluate(() => {
        const long: number[] = [];
        Reflect.set(window, "__longTasks", long);
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) long.push(e.duration);
        }).observe({ type: "longtask" });
      });
      await page.locator("body").click({ position: { x: 2, y: 2 } });
      // The room renders on demand (ADR 0029): wait until it has drawn nothing for a whole second.
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
      await page.keyboard.press("t");
      await expect(page.getByRole("menu", { name: "Emotes" })).toBeVisible();
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("Escape");
      await page.keyboard.press("t");
      await page.waitForTimeout(500);
      expect(await roomRenders(page)).toBe(last);
      const long = await page.evaluate(() => {
        const l: unknown = Reflect.get(window, "__longTasks");
        return Array.isArray(l) ? l.filter((d): d is number => typeof d === "number" && d > 50) : [];
      });
      expect(long).toEqual([]);
    });

    test("it closes when your own avatar starts walking", async ({ browser }) => {
      const { a } = await pair(browser, "wheelwalk");
      await a.page.locator("body").click({ position: { x: 2, y: 2 } });
      await a.page.keyboard.press("t");
      const wheel = a.page.getByRole("menu", { name: "Emotes" });
      await expect(wheel).toBeVisible();
      // A sit from elsewhere (another tab of mine would do the same): my avatar walks to the seat.
      await a.page.evaluate(() => {
        const debug: unknown = Reflect.get(window, "__omega");
        const room: unknown = typeof debug === "object" && debug !== null ? Reflect.get(debug, "room") : null;
        const send: unknown = typeof room === "object" && room !== null ? Reflect.get(room, "send") : null;
        if (typeof send === "function") Reflect.apply(send, room, [{ type: "sit", seat: 3 }]);
      });
      await expect(wheel).toBeHidden({ timeout: 5000 });
    });

    test("touch: the wheel key by the chat input opens it; 42 px slots; reduced motion skips the fade", async ({ browser }) => {
      clients = await joinRoom(browser, {
        roomUrl: testRoom("emotes", "wheeltap").url,
        count: 1,
        nicknamePrefix: "wheeltap",
        contextOptions: () => ({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, reducedMotion: "reduce" }),
      });
      const page = clients[0]?.page;
      if (page === undefined) throw new Error("no client");
      const key = page.getByTestId("emote-key");
      await expect(key.locator(".ui-icon-wheel")).toHaveCount(1);
      await key.tap();
      const wheel = page.getByRole("menu", { name: "Emotes" });
      await expect(wheel).toBeVisible();
      expect(await wheel.evaluate((e) => getComputedStyle(e).animationName)).toBe("none");
      const slot = await page.getByRole("menuitem", { name: "Clap" }).boundingBox();
      expect(slot?.width).toBe(42);
      expect(slot?.height).toBe(42);
      // Inside the window, wherever it went (over my head, or docked above the composer).
      const box = await wheel.boundingBox();
      if (box === null) throw new Error("no wheel box");
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
      expect(box.y).toBeGreaterThanOrEqual(0);
      await page.getByRole("menuitem", { name: "Clap" }).tap();
      await expect(wheel).toBeHidden();
    });
  });
});
