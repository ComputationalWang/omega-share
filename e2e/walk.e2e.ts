// Walking (OME-408): every client walks avatars to their new spot itself; the motion sheets load after join.
import { expect, test, watchCsp } from "./support/csp";
import type { BrowserContext, Page, Request } from "@playwright/test";
import { PENDING, available } from "./support/apps";
import { joinRoom, leaveAll, testRoom, type Client } from "./support/room";
import { stubExternalNetwork } from "./support/network";
import { site } from "./support/selectors";

test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);

let clients: Client[] = [];
test.afterEach(async () => {
  await leaveAll(clients);
  clients = [];
});

/** The set (a) avatar sheet, the set (d) motion sheet, or the chunk that loads them. */
const isMotion = (r: Request): boolean => /\/avatars\/(avatars|motion)\.(png|json)|motion-atlas/.test(r.url());

/** Forces a walk tier (ADR 0037) in every page of `context`, as `localStorage["omega.motion"]` does. */
const forceTier = (tier: "smooth" | "basic") => async (context: BrowserContext): Promise<void> => {
  await context.addInitScript((t) => {
    localStorage.setItem("omega.motion", t);
  }, tier);
};

/** The stage px of each tag transform `translate(Xpx, Ypx)`. */
function points(path: readonly string[]): { x: number; y: number }[] {
  return path.flatMap((t) => {
    const m = /^translate\(([-\d.]+)px, ([-\d.]+)px\)$/.exec(t);
    return m === null ? [] : [{ x: Number(m[1]), y: Number(m[2]) }];
  });
}

/** The largest move between two consecutive positions, per axis. */
function largestStep(path: readonly string[]): { x: number; y: number } {
  const p = points(path);
  let x = 0;
  let y = 0;
  for (let i = 1; i < p.length; i++) {
    x = Math.max(x, Math.abs((p[i]?.x ?? 0) - (p[i - 1]?.x ?? 0)));
    y = Math.max(y, Math.abs((p[i]?.y ?? 0) - (p[i - 1]?.y ?? 0)));
  }
  return { x, y };
}

/** Every distinct transform `nickname`'s tag takes on `page` over `ms`, sampled each frame, while `act` runs. */
async function tagPath(page: Page, nickname: string, ms: number, act: () => Promise<void>): Promise<string[]> {
  const tag = page.locator(site.nicknameTag).filter({ hasText: nickname });
  await expect(tag).toHaveCount(1);
  const handle = await tag.elementHandle();
  const sampled = page.evaluate(
    ([el, duration]) =>
      new Promise<string[]>((resolve) => {
        const seen: string[] = [];
        const end = performance.now() + duration;
        const tick = (): void => {
          const t = (el as HTMLElement).style.transform;
          if (seen.at(-1) !== t) seen.push(t);
          if (performance.now() < end) requestAnimationFrame(tick);
          else resolve(seen);
        };
        requestAnimationFrame(tick);
      }),
    [handle, ms] as const,
  );
  await act();
  return sampled;
}

test("the room draws on a 2D canvas (ADR 0029): no WebGL readback each frame while avatars walk", async ({ browser }) => {
  clients = await joinRoom(browser, { roomUrl: testRoom("walk", "main").url, count: 1, nicknamePrefix: "canvas" });
  const [a] = clients;
  if (a === undefined) throw new Error("no client");
  const is2d = await a.page.locator("canvas.scene").evaluate((c) => (c as HTMLCanvasElement).getContext("2d") !== null);
  expect(is2d).toBe(true);
});

test("the motion sheets load after join, not on the landing page", async ({ browser }) => {
  const context = await watchCsp(await browser.newContext());
  await stubExternalNetwork(context);
  const page = await context.newPage();
  const seen: string[] = [];
  page.on("request", (r) => {
    if (isMotion(r)) seen.push(r.url());
  });
  await page.goto(testRoom("walk", "main").url);
  await page.locator(site.nicknameInput).waitFor();
  await page.waitForLoadState("networkidle");
  expect(seen, "nothing of the motion atlas before joining").toEqual([]);
  await page.locator(site.nicknameInput).fill("sheets-1");
  await page.locator(site.avatarOption).first().click();
  await page.locator(site.joinButton).click();
  await page.locator(site.room).waitFor();
  await expect.poll(() => seen.some((u) => u.includes("motion.png")), { timeout: 10_000 }).toBe(true);
  await context.close();
});

test("Basic: a seat change walks in whole 8 × 4 px steps: the others see the tag pass between the spot and the seat, then rest on the seat", async ({ browser }) => {
  clients = await joinRoom(browser, { roomUrl: testRoom("walk", "main").url, count: 2, nicknamePrefix: "walker", setup: forceTier("basic") });
  const [a, b] = clients;
  if (a === undefined || b === undefined) throw new Error("need two clients");
  await a.page.waitForTimeout(6000); // b walked in from the door
  const seat = a.page.locator(`${site.seat}[data-seat="0"]`);
  const path = await tagPath(a.page, "walker-2", 8000, () => b.page.locator(`${site.seat}[data-seat="0"]`).click());
  expect(path.length, `positions: ${path.join(" | ")}`).toBeGreaterThan(10);
  // At rest on the seat: the tag hangs below the seat's floor point (layout.ts TAG_OFFSET_Y = 10).
  // The seat is placed with the translate property ("x y", or "x" when y is 0).
  const seatAt = /^([-\d.]+)px(?: ([-\d.]+)px)?$/.exec(await seat.evaluate((e) => (e as HTMLElement).style.translate));
  expect(path.at(-1)).toBe(`translate(${seatAt?.[1] ?? "?"}px, ${String(Number(seatAt?.[2] ?? "0") + 10)}px)`);
  await expect(a.page.locator("canvas.scene")).toHaveAttribute("data-motion", "basic");
  // One stepPx (8 × 4) per 150 ms frame: never a move in between.
  for (const p of points(path).slice(1, -1)) expect(Number.isInteger(p.x) && Number.isInteger(p.y), `positions: ${path.join(" | ")}`).toBe(true);
  expect(largestStep(path.slice(0, -1))).toEqual({ x: 8, y: 4 });
});

test("Smooth: a seat change walks every frame in whole px, then rests on the same seat", async ({ browser }) => {
  clients = await joinRoom(browser, { roomUrl: testRoom("walk", "smooth").url, count: 2, nicknamePrefix: "glider", setup: forceTier("smooth") });
  const [a, b] = clients;
  if (a === undefined || b === undefined) throw new Error("need two clients");
  await expect(a.page.locator("canvas.scene")).toHaveAttribute("data-motion", "smooth");
  await a.page.waitForTimeout(6000);
  const seat = a.page.locator(`${site.seat}[data-seat="0"]`);
  const path = await tagPath(a.page, "glider-2", 8000, () => b.page.locator(`${site.seat}[data-seat="0"]`).click());
  // Basic shows one position per 150 ms step; Smooth one per whole px, about twice as many and none of them 8 px apart.
  expect(path.length, `positions: ${path.join(" | ")}`).toBeGreaterThan(30);
  for (const p of points(path)) expect(Number.isInteger(p.x) && Number.isInteger(p.y), `positions: ${path.join(" | ")}`).toBe(true);
  const step = largestStep(path);
  expect(step.x, `positions: ${path.join(" | ")}`).toBeLessThan(8);
  expect(step.y, `positions: ${path.join(" | ")}`).toBeLessThan(4);
  const seatAt = /^([-\d.]+)px(?: ([-\d.]+)px)?$/.exec(await seat.evaluate((e) => (e as HTMLElement).style.translate));
  expect(path.at(-1)).toBe(`translate(${seatAt?.[1] ?? "?"}px, ${String(Number(seatAt?.[2] ?? "0") + 10)}px)`);
});

test("a stored motion tier that isn't smooth or basic is ignored: the room starts in Basic", async ({ browser }) => {
  clients = await joinRoom(browser, {
    roomUrl: testRoom("walk", "smooth").url,
    count: 1,
    nicknamePrefix: "odd",
    setup: async (context) => {
      await context.addInitScript(() => {
        localStorage.setItem("omega.motion", "turbo");
      });
    },
  });
  const [a] = clients;
  if (a === undefined) throw new Error("no client");
  await expect(a.page.locator("canvas.scene")).toHaveAttribute("data-motion", "basic");
});

test("prefers-reduced-motion: the others' avatars jump straight to the seat", async ({ browser }) => {
  // Forced Smooth: reduced motion still means no walk at all, on either tier.
  clients = await joinRoom(browser, { roomUrl: testRoom("walk", "reduced").url, count: 2, nicknamePrefix: "still", setup: forceTier("smooth") });
  const [a, b] = clients;
  if (a === undefined || b === undefined) throw new Error("need two clients");
  await a.page.emulateMedia({ reducedMotion: "reduce" });
  await a.page.waitForTimeout(6000);
  const path = await tagPath(a.page, "still-2", 3000, () => b.page.locator(`${site.seat}[data-seat="0"]`).click());
  expect(path.length, `positions: ${path.join(" | ")}`).toBeLessThanOrEqual(2);
});
