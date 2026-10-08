// Walking (OME-408): every client walks avatars to their new spot itself; the motion sheets load after join.
import { expect, test, watchCsp } from "./support/csp";
import type { Page, Request } from "@playwright/test";
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

test("a seat change walks: the others see the tag pass between the spot and the seat, then rest on the seat", async ({ browser }) => {
  clients = await joinRoom(browser, { roomUrl: testRoom("walk", "main").url, count: 2, nicknamePrefix: "walker" });
  const [a, b] = clients;
  if (a === undefined || b === undefined) throw new Error("need two clients");
  await a.page.waitForTimeout(6000); // b walked in from the door
  const seat = a.page.locator(`${site.seat}[data-seat="0"]`);
  const path = await tagPath(a.page, "walker-2", 8000, () => b.page.locator(`${site.seat}[data-seat="0"]`).click());
  expect(path.length, `positions: ${path.join(" | ")}`).toBeGreaterThan(10);
  // At rest on the seat: the tag hangs below the seat's floor point (layout.ts TAG_OFFSET_Y = 10).
  const seatAt = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(await seat.evaluate((e) => (e as HTMLElement).style.transform));
  expect(path.at(-1)).toBe(`translate(${seatAt?.[1] ?? "?"}px, ${String(Number(seatAt?.[2]) + 10)}px)`);
});

test("prefers-reduced-motion: the others' avatars jump straight to the seat", async ({ browser }) => {
  clients = await joinRoom(browser, { roomUrl: testRoom("walk", "reduced").url, count: 2, nicknamePrefix: "still" });
  const [a, b] = clients;
  if (a === undefined || b === undefined) throw new Error("need two clients");
  await a.page.emulateMedia({ reducedMotion: "reduce" });
  await a.page.waitForTimeout(6000);
  const path = await tagPath(a.page, "still-2", 3000, () => b.page.locator(`${site.seat}[data-seat="0"]`).click());
  expect(path.length, `positions: ${path.join(" | ")}`).toBeLessThanOrEqual(2);
});
