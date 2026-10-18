// Walking (OME-408): every client walks avatars to their new spot itself; the motion sheets load after join.
import { expect, test, watchCsp } from "./support/csp";
import type { BrowserContext, Page, Request } from "@playwright/test";
import { PENDING, available } from "./support/apps";
import { joinRoom, leaveAll, testRoom, type Client } from "./support/room";
import { stubExternalNetwork } from "./support/network";
import { site } from "./support/selectors";
import { TAG_OFFSET_Y, cellCenter } from "../apps/web/src/layout";
import { TILE_MS } from "../apps/web/src/walk/walks";

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

/** Each move between two consecutive positions, per axis. */
function steps(path: readonly string[]): { x: number; y: number }[] {
  const p = points(path);
  return p.slice(1).map((q, i) => ({ x: Math.abs(q.x - (p[i]?.x ?? 0)), y: Math.abs(q.y - (p[i]?.y ?? 0)) }));
}

/** The largest move between two consecutive positions, per axis. */
function largestStep(path: readonly string[]): { x: number; y: number } {
  return steps(path).reduce((m, s) => ({ x: Math.max(m.x, s.x), y: Math.max(m.y, s.y) }), { x: 0, y: 0 });
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
          // A tag hangs from the translate property ("x y", or "x" when y is 0, OME-1184), read as translate(x, y).
          const [x, y = "0px"] = (el as HTMLElement).style.translate.split(" ");
          const t = x === undefined || x === "" ? "" : `translate(${x}, ${y})`;
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
  // The landing's avatar picker draws its four idle frames straight from avatars.png (OME-934/935 handoff, CSS
  // background, no JSON); the motion sheet and both atlases' JSON still wait for the room.
  expect(seen.filter((u) => !/\/avatars\/avatars\.png(?:\?|$)/.test(u)), "nothing of the motion atlas before joining").toEqual([]);
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
  // Basic shows one position per 150 ms step, each a whole 8 × 4 px apart; Smooth one per frame, in whole px. A frame
  // dropped on a busy box can put two Smooth positions a Basic step apart (two full local runs at once, OME-879), so
  // the claim is the share: most moves are shorter than a Basic step, which Basic never draws.
  expect(path.length, `positions: ${path.join(" | ")}`).toBeGreaterThan(10);
  for (const p of points(path)) expect(Number.isInteger(p.x) && Number.isInteger(p.y), `positions: ${path.join(" | ")}`).toBe(true);
  const moves = steps(path);
  const short = moves.filter((m) => m.x < 8 && m.y < 4).length;
  expect(short, `${String(short)} of ${String(moves.length)} moves shorter than 8 × 4 px; positions: ${path.join(" | ")}`).toBeGreaterThan(moves.length / 2);
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

// Free walking (OME-1350, ADR 0053), on the default layout: (0,0) is the TV, (3,8) and (4,8) open floor.

/** Where `nickname`'s tag hangs when they rest on cell (x, y): the cell's centre, TAG_OFFSET_Y below. */
const restOn = (x: number, y: number): string => {
  const p = cellCenter(x, y);
  return `${String(Math.round(p.x))}px ${String(Math.round(p.y + TAG_OFFSET_Y))}px`;
};
const tagAt = (page: Page, nickname: string): Promise<string> => page.locator(site.nicknameTag).filter({ hasText: nickname }).evaluate((el) => (el as HTMLElement).style.translate);

/** Clicks stage point `cellCenter(x, y)` on the floor layer, wherever the stage is scaled to. */
async function clickCell(page: Page, x: number, y: number): Promise<void> {
  const floor = page.locator(site.walkFloor);
  const box = await floor.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, k: r.width / (el as HTMLElement).offsetWidth };
  });
  const p = cellCenter(x, y);
  await page.mouse.click(box.left + p.x * box.k, box.top + p.y * box.k);
}

/** A `walk` frame the page sent, and the page's `performance.now()` when it did. */
interface SentWalk {
  at: number;
  data: string;
}

/** Every `walk` frame `page` sends from now on (the socket is already open, so its `send` is wrapped in place). */
async function spyWalks(page: Page): Promise<SentWalk[]> {
  const walks: SentWalk[] = [];
  await page.exposeFunction("__sentWalk", (data: string, at: number) => walks.push({ at, data }));
  await page.evaluate(() => {
    const proto = WebSocket.prototype;
    const send: unknown = Reflect.get(proto, "send");
    if (typeof send !== "function") return;
    Reflect.set(proto, "send", function (this: WebSocket, data: unknown) {
      const spy: unknown = Reflect.get(window, "__sentWalk");
      if (typeof data === "string" && data.includes('"walk"') && typeof spy === "function") Reflect.apply(spy, window, [data, performance.now()]);
      Reflect.apply(send, this, [data]);
    });
  });
  return walks;
}

test("a click on free floor walks there: everyone sees the walk and rests on that cell; an arrow key then steps one cell", async ({ browser }) => {
  clients = await joinRoom(browser, { roomUrl: testRoom("walk", "free").url, count: 2, nicknamePrefix: "free" });
  const [a, b] = clients;
  if (a === undefined || b === undefined) throw new Error("need two clients");
  await a.page.waitForTimeout(6000); // b walked in from the door
  const path = await tagPath(a.page, "free-2", 8000, () => clickCell(b.page, 3, 8));
  expect(path.length, `the others see b walk: ${path.join(" | ")}`).toBeGreaterThan(3);
  for (const page of [a.page, b.page]) await expect.poll(() => tagAt(page, "free-2"), { timeout: 10_000 }).toBe(restOn(3, 8));
  // The keyboard way (a11y): the floor takes focus, and an arrow key steps one cell.
  await b.page.locator(site.walkFloor).focus();
  await b.page.keyboard.press("ArrowRight");
  for (const page of [a.page, b.page]) await expect.poll(() => tagAt(page, "free-2"), { timeout: 10_000 }).toBe(restOn(4, 8));
});

// OME-1376: Walk over (People list; the owner's member menu runs the same intent) walks me beside the other one.
test("Walk over walks me to a free cell beside them", async ({ browser }) => {
  clients = await joinRoom(browser, { roomUrl: testRoom("walk", "over").url, count: 2, nicknamePrefix: "over" });
  const [a, b] = clients;
  if (a === undefined || b === undefined) throw new Error("need two clients");
  await a.page.waitForTimeout(6000); // b walked in from the door
  await clickCell(b.page, 3, 8);
  await expect.poll(() => tagAt(a.page, "over-2"), { timeout: 10_000 }).toBe(restOn(3, 8));
  await a.page.locator(site.peopleKey).click();
  await a.page.locator(site.peopleRow).filter({ hasText: "over-2" }).locator(site.peopleWalkOver).click();
  const beside = [restOn(2, 8), restOn(4, 8), restOn(3, 7), restOn(3, 9)];
  for (const page of [a.page, b.page]) await expect.poll(async () => beside.includes(await tagAt(page, "over-1")), { timeout: 15_000 }).toBe(true);
});

test("a held arrow key steps at most once a tile", async ({ browser }) => {
  clients = await joinRoom(browser, { roomUrl: testRoom("walk", "keys").url, count: 1, nicknamePrefix: "keys" });
  const [a] = clients;
  if (a === undefined) throw new Error("no client");
  await a.page.waitForTimeout(4000);
  await clickCell(a.page, 9, 8);
  await expect.poll(() => tagAt(a.page, "keys-1"), { timeout: 10_000 }).toBe(restOn(9, 8));
  const walks = await spyWalks(a.page);
  await a.page.locator(site.walkFloor).focus();
  // Held for at least 1.5 s: the browser repeats the key ~every 33 ms, the room steps at most once per 600 ms tile.
  await a.page.keyboard.down("ArrowLeft");
  for (let i = 0; i < 45; i++) {
    await a.page.keyboard.down("ArrowLeft");
    await a.page.waitForTimeout(33);
  }
  await a.page.keyboard.up("ArrowLeft");
  // The bound is on the page's own clock, not a count: a loaded runner holds longer and may step more (OME-1368).
  const log = walks.map((w) => `${w.at.toFixed(0)} ${w.data}`).join(" | ");
  expect(walks.length, log).toBeGreaterThanOrEqual(2);
  // 5 ms slack: the gate reads the clock just before the send it times.
  for (let i = 1; i < walks.length; i++) expect((walks[i]?.at ?? 0) - (walks[i - 1]?.at ?? 0), log).toBeGreaterThanOrEqual(TILE_MS - 5);
});

test("a click on a solid piece sends nothing and flashes can't-go-there", async ({ browser }) => {
  clients = await joinRoom(browser, { roomUrl: testRoom("walk", "blocked").url, count: 1, nicknamePrefix: "blocked" });
  const [a] = clients;
  if (a === undefined) throw new Error("no client");
  await a.page.waitForTimeout(4000);
  const sent = await spyWalks(a.page);
  const before = await tagAt(a.page, "blocked-1");
  await clickCell(a.page, 0, 0);
  const note = a.page.locator(`${site.walkFloor} + [role="status"]`);
  await expect(a.page.locator(site.walkFloor)).toHaveClass(/\bno-go\b/);
  await expect(a.page.locator(site.walkFloor)).not.toHaveClass(/\bno-go\b/, { timeout: 2000 });
  // The cursor flash is 400 ms; the note stays ~1.5 s so a screen reader that polls late still says it (OME-1364).
  await expect(note).toHaveText("You can't go there.");
  await expect(note).toHaveText("", { timeout: 3000 });
  expect(sent).toEqual([]);
  expect(await tagAt(a.page, "blocked-1")).toBe(before);
});
