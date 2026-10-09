// M5 polish QA (OME-418): what walk.e2e / emotes.e2e leave out. A seat change walks then sits on every client, a late
// joiner sees the seated avatars already seated (no walk replay), and the server drops emotes over the per-member bucket.
import * as v from "valibot";
import { EMOTE_BURST, EMOTE_REFILL_MS, parseServerMessage } from "@omega/shared";
import { expect, test } from "./support/csp";
import type { Browser, Page } from "@playwright/test";
import { PENDING, URLS, available } from "./support/apps";
import { socketUrl } from "./support/bots";
import { watchCsp } from "./support/csp";
import { clickSettled, joinRoom, leaveAll, testRoom, type Client } from "./support/room";
import { site } from "./support/selectors";

test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);

let clients: Client[] = [];
let closers: (() => Promise<void>)[] = [];
test.afterEach(async () => {
  await leaveAll(clients);
  await Promise.all(closers.map((c) => c()));
  clients = [];
  closers = [];
});

const Frames = v.nullable(v.object({ avatar: v.nullable(v.string()), sticker: v.nullable(v.string()) }));
const SITTING = /^(breathe\/)?\w+\/sit\//;
const IDLE = /^(breathe\/)?\w+\/idle\//;
/** layout.ts TAG_OFFSET_Y: a tag at rest hangs this far below its spot's floor point. */
const TAG_OFFSET_Y = 10;

/** The dev handle (apps/web/src/main.ts `window.__omega.room`): my member id. */
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

/** The frames `page` draws `id` with now. */
async function frames(page: Page, id: string): Promise<v.InferOutput<typeof Frames>> {
  const f = await page.evaluate((id) => {
    const debug: unknown = Reflect.get(window, "__omega");
    const room: unknown = typeof debug === "object" && debug !== null ? Reflect.get(debug, "room") : null;
    const get: unknown = typeof room === "object" && room !== null ? Reflect.get(room, "avatarFrames") : null;
    return typeof get === "function" ? ((Reflect.apply(get, room, [id]) as unknown) ?? null) : null;
  }, id);
  return v.parse(Frames, f);
}

const avatarOf = async (page: Page, id: string): Promise<string> => (await frames(page, id))?.avatar ?? "";

/** Where a tag rests when its member sits on `seat` on `page`. */
async function seatTagAt(page: Page, seat: number): Promise<string> {
  const t = await page.locator(`${site.seat}[data-seat="${String(seat)}"]`).evaluate((e) => (e as HTMLElement).style.transform);
  const at = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(t);
  if (at?.[1] === undefined || at[2] === undefined) throw new Error(`seat ${String(seat)}: no translate in "${t}"`);
  return `translate(${at[1]}px, ${String(Number(at[2]) + TAG_OFFSET_Y)}px)`;
}

/** Every distinct transform `nickname`'s tag takes on `page` over `ms`, sampled each frame from now. */
async function tagPath(page: Page, nickname: string, ms: number): Promise<string[]> {
  const tag = page.locator(site.nicknameTag).filter({ hasText: nickname });
  await expect(tag).toHaveCount(1);
  const handle = await tag.elementHandle();
  return page.evaluate(
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
}

/** Waits until every page draws every one of `ids` at rest in a set (a) idle frame (the walk in from the door is over). */
async function settled(pages: readonly Page[], ids: readonly string[]): Promise<void> {
  for (const page of pages) for (const id of ids) await expect.poll(() => avatarOf(page, id), { timeout: 15_000 }).toMatch(IDLE);
}

test("a seat change walks then sits on every client", async ({ browser }) => {
  clients = await joinRoom(browser, { roomUrl: testRoom("polish", "every").url, count: 4, nicknamePrefix: "every" });
  const [mover, ...observers] = clients;
  if (mover === undefined || observers.length !== 3) throw new Error("need four clients");
  const moverId = await self(mover.page);
  await settled(observers.map((o) => o.page), [moverId]);
  const paths = observers.map((o) => tagPath(o.page, mover.nickname, 8000));
  await clickSettled(mover.page, mover.page.locator(`${site.seat}[data-seat="0"]`));
  const walked = await Promise.all(paths);
  for (const [i, o] of observers.entries()) {
    const path = walked[i] ?? [];
    // Start, at least two steps between, the seat: a walk, not a jump (the route's length depends on the idle spot).
    expect(path.length, `${o.nickname} saw ${path.join(" | ")}`).toBeGreaterThanOrEqual(4);
    expect(path.at(-1), `${o.nickname}: at rest on the seat`).toBe(await seatTagAt(o.page, 0));
    await expect.poll(() => avatarOf(o.page, moverId), { timeout: 3000 }).toMatch(SITTING);
  }
});

test("late joiners see seated avatars already seated, with no walk", async ({ browser }) => {
  const room = testRoom("polish", "late");
  clients = await joinRoom(browser, { roomUrl: room.url, count: 2, nicknamePrefix: "early" });
  const [a, b] = clients;
  if (a === undefined || b === undefined) throw new Error("need two clients");
  const ids = [await self(a.page), await self(b.page)];
  await settled([a.page], ids);
  await clickSettled(a.page, a.page.locator(`${site.seat}[data-seat="0"]`));
  await clickSettled(b.page, b.page.locator(`${site.seat}[data-seat="1"]`));
  for (const id of ids) await expect.poll(() => avatarOf(a.page, id), { timeout: 15_000 }).toMatch(SITTING);

  const [late] = await joinRoom(browser, { roomUrl: room.url, count: 1, nicknamePrefix: "late" });
  if (late === undefined) throw new Error("no late joiner");
  clients.push(late);
  const paths = await Promise.all([tagPath(late.page, a.nickname, 2000), tagPath(late.page, b.nickname, 2000)]);
  for (const [i, id] of ids.entries()) {
    expect(await avatarOf(late.page, id), "seated in the snapshot, drawn seated").toMatch(SITTING);
    const path = paths[i] ?? [];
    expect(path.length, `no walk replay: ${path.join(" | ")}`).toBeLessThanOrEqual(2);
    expect(path.at(-1)).toBe(await seatTagAt(late.page, i));
  }
});

/** A raw member socket on a page of the site origin. `burst(n)` sends n emotes back to back and reports what came back. */
async function rawMember(browser: Browser, roomId: string): Promise<{ id: string; burst: (n: number, listenMs: number, gapMs?: number) => Promise<{ emoted: number; rateLimited: number }> }> {
  const context = await watchCsp(await browser.newContext());
  closers.push(() => context.close());
  const page = await context.newPage();
  await page.goto(URLS.web);
  const id = await page.evaluate(
    (url) =>
      new Promise<string>((resolve, reject) => {
        const ws = new WebSocket(url);
        Object.assign(window, { omegaRaw: ws });
        ws.addEventListener("open", () => {
          ws.send(JSON.stringify({ type: "join", nickname: "burster", avatar: 0 }));
        });
        ws.addEventListener("message", (ev: MessageEvent<unknown>) => {
          const msg: unknown = typeof ev.data === "string" ? JSON.parse(ev.data) : null;
          if (typeof msg === "object" && msg !== null && "type" in msg && msg.type === "snapshot" && "self" in msg && typeof msg.self === "string") resolve(msg.self);
        });
        ws.addEventListener("close", () => {
          reject(new Error("closed before snapshot"));
        });
      }),
    socketUrl(roomId),
  );
  const burst = async (n: number, listenMs: number, gapMs = 0): Promise<{ emoted: number; rateLimited: number }> => {
    const r = await page.evaluate(
      ({ n, listenMs, gapMs, self }) =>
        new Promise<unknown>((resolve) => {
          const ws: unknown = Reflect.get(window, "omegaRaw");
          if (!(ws instanceof WebSocket)) throw new Error("no raw socket");
          let emoted = 0;
          let rateLimited = 0;
          const on = (ev: MessageEvent<unknown>): void => {
            const msg: unknown = typeof ev.data === "string" ? JSON.parse(ev.data) : null;
            if (typeof msg !== "object" || msg === null || !("type" in msg)) return;
            if (msg.type === "emoted" && "memberId" in msg && msg.memberId === self) emoted++;
            if (msg.type === "error" && "code" in msg && msg.code === "rate_limited") rateLimited++;
          };
          ws.addEventListener("message", on);
          const send = (): void => {
            ws.send(JSON.stringify({ type: "emote", kind: "heart" }));
          };
          if (gapMs === 0) for (let i = 0; i < n; i++) send();
          else for (let i = 0; i < n; i++) setTimeout(send, i * gapMs);
          setTimeout(() => {
            ws.removeEventListener("message", on);
            resolve({ emoted, rateLimited });
          }, (n - 1) * gapMs + listenMs);
        }),
      { n, listenMs, gapMs, self: id },
    );
    return v.parse(v.object({ emoted: v.number(), rateLimited: v.number() }), r);
  };
  return { id, burst };
}

test("over-limit emotes are dropped by the server: only the burst reaches the room, then one per refill", async ({ browser }) => {
  const room = testRoom("polish", "drop");
  const seen: string[] = [];
  clients = await joinRoom(browser, {
    roomUrl: room.url,
    count: 1,
    nicknamePrefix: "watcher",
    setup: async (context) => {
      context.on("page", (page) => {
        page.on("websocket", (ws) => {
          ws.on("framereceived", ({ payload }) => {
            const msg = typeof payload === "string" ? parseServerMessage(payload) : null;
            if (msg?.type === "emoted") seen.push(msg.memberId);
          });
        });
      });
      await Promise.resolve();
    },
  });
  const [watcher] = clients;
  if (watcher === undefined) throw new Error("no watcher");
  const raw = await rawMember(browser, room.id);
  const relayedToWatcher = (): number => seen.filter((m) => m === raw.id).length;

  // Well inside one refill: the burst goes through, the rest is refused and never fanned out.
  const first = await raw.burst(EMOTE_BURST + 3, Math.min(600, EMOTE_REFILL_MS - 200));
  expect(first.emoted, "the sender's own echo: the burst only").toBe(EMOTE_BURST);
  expect(first.rateLimited, "the sender is told").toBeGreaterThanOrEqual(1);
  await expect.poll(relayedToWatcher, { timeout: 1000 }).toBe(EMOTE_BURST);
  await watcher.page.waitForTimeout(300);
  expect(relayedToWatcher(), "nothing over the bucket reached the room").toBe(EMOTE_BURST);

  // Then one per refill: drained, a steady 4 a second for 2.2 s gets 2.2 refills' worth through (plus under one
  // left over), so 2 or 3 of 9; a refill twice as fast would let 4 or more through.
  await raw.burst(EMOTE_BURST, 0);
  const before = relayedToWatcher();
  const paced = await raw.burst(9, 600, 250);
  expect(paced.emoted, "one per EMOTE_REFILL_MS").toBeGreaterThanOrEqual(2);
  expect(paced.emoted, "one per EMOTE_REFILL_MS").toBeLessThanOrEqual(3);
  await watcher.page.waitForTimeout(300);
  expect(relayedToWatcher() - before, "the room got exactly what the sender's echo got").toBe(paced.emoted);
});
