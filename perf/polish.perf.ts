// OME-418: the M5 polish (walking, emotes) against the frame budgets, per provider (ADR 0009/0017): the observer's
// frames while 8 avatars walk to their seats at once, and while 8 avatars emote at the allowed rate, video playing.
// Self-enforced like editor.perf.ts (quantised p95 ≤ one vsync, ≤ 1 % missed, ≤ 8 ms main-thread work p95); numbers
// in perf/results/polish.json. Run with Playwright tracing off (playwright.config.ts perf project) for missed vsyncs.
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_ROOM_ID, EMOTE_REFILL_MS, parseServerMessage } from "@omega/shared";
import { PENDING, URLS, available } from "../e2e/support/apps";
import { clickSettled, joinRoom, leaveAll, type Client } from "../e2e/support/room";
import { joinForToken, postShare } from "../e2e/support/share";
import { site } from "../e2e/support/selectors";
import type { FrameProvider } from "./budgets";
import { VSYNC_MS, tracedFrames, type FrameWindow } from "./frames";
import { RESULTS_DIR, p95 } from "./metrics";
import { PROVIDER_CASES, providerCase, shareProvider, waitProviderPlaying } from "./providers";
import { summarizeFrames } from "./spread";
import { shareVideo, waitPlaying } from "./sync";

const CLIENTS = 8;
const WINDOW_MS = 5000;
/** A sustained emote rate the client's own bucket (a little slower than the server's) always lets through. */
const EMOTE_EVERY_MS = EMOTE_REFILL_MS + 200;

// As site.perf.ts (OME-294): the generic host serves a local page repainting every frame, a stand-in for a video.
const GENERIC_HOST = "video.omega-fixture.org";
const GENERIC_PAGE = `<!doctype html><title>generic</title><style>
  html, body { margin: 0; height: 100%; background: #111; overflow: hidden; }
  div { width: 40%; height: 40%; background: #4a8; animation: m 1s linear infinite alternate; }
  @keyframes m { from { transform: translateX(0) rotate(0); } to { transform: translateX(120%) rotate(180deg); } }
</style><div></div><canvas width="640" height="360"></canvas><script>
  const g = document.querySelector("canvas").getContext("2d");
  const draw = (t) => {
    for (let i = 0; i < 64; i++) { g.fillStyle = "hsl(" + ((t / 10 + i * 5) % 360) + ",60%,50%)"; g.fillRect((i % 8) * 80, Math.floor(i / 8) * 45, 80, 45); }
    requestAnimationFrame(draw);
  };
  requestAnimationFrame(draw);
</script>`;

/** Shares the provider's video into the lobby, joins 8 clients (`setup` per context) and waits for it to play everywhere. */
async function joinWithVideo(
  browser: Parameters<typeof joinRoom>[0],
  request: APIRequestContext,
  provider: FrameProvider,
  prefix: string,
  setup?: (context: BrowserContext, index: number) => Promise<void>,
): Promise<Client[]> {
  const roomUrl = `${URLS.web}/r/${DEFAULT_ROOM_ID}`;
  if (provider === "youtube") await shareVideo(request);
  else if (provider === "generic") {
    const sharer = await joinForToken(DEFAULT_ROOM_ID, `${prefix}-sharer`);
    try {
      expect((await postShare(request, DEFAULT_ROOM_ID, sharer.token, `https://${GENERIC_HOST}/embed/42`)).status()).toBe(200);
    } finally {
      sharer.close();
    }
  } else await shareProvider(request, providerCase(provider).shareUrl);
  const clients = await joinRoom(browser, {
    roomUrl,
    count: CLIENTS,
    nicknamePrefix: prefix,
    setup: async (context, index) => {
      if (provider === "generic") await context.route(`https://${GENERIC_HOST}/**`, (route) => route.fulfill({ contentType: "text/html", body: GENERIC_PAGE }));
      await setup?.(context, index);
    },
  });
  if (provider === "youtube") await waitPlaying(clients);
  else if (provider === "generic") {
    for (const c of clients) {
      await c.page.getByTestId("generic-load").click({ timeout: 15_000 });
      await expect(c.page.frameLocator(site.sharedVideo).locator("div")).toBeVisible({ timeout: 15_000 });
    }
  } else await waitProviderPlaying(clients, providerCase(provider).provider);
  return clients;
}

/** How many nickname tags on `page` take ≥ 4 distinct transforms over `ms`, i.e. walk. */
const walkingTags = (page: Page, ms: number): Promise<number> =>
  page.evaluate(
    (duration) =>
      new Promise<number>((resolve) => {
        const seen = new Map<Element, Set<string>>();
        const id = setInterval(() => {
          for (const t of document.querySelectorAll("[data-testid='nickname-tag']")) {
            const s = seen.get(t) ?? new Set<string>();
            s.add((t as HTMLElement).style.transform);
            seen.set(t, s);
          }
        }, 100);
        setTimeout(() => {
          clearInterval(id);
          resolve([...seen.values()].filter((s) => s.size >= 4).length);
        }, duration);
      }),
    ms,
  );

const out: Record<string, unknown> = {};
const row = (w: FrameWindow, extra: Record<string, unknown>) => {
  const f = summarizeFrames(w.samples, VSYNC_MS);
  return { p95: f.p95, missedPct: f.missedPct, missed: f.missed, frames: f.frames, maxMs: Math.max(...w.samples), rawP95: p95(w.samples), workP95: p95(w.workMs), workMax: Math.max(...w.workMs), traced: w.workMs.length, ...extra };
};
const withinBudget = (k: string, r: ReturnType<typeof row>): void => {
  expect(r.p95, `${k} frame p95`).toBeLessThanOrEqual(VSYNC_MS + 1e-6);
  expect(r.missedPct, `${k} missed vsyncs %`).toBeLessThanOrEqual(1);
  expect(r.workP95, `${k} main-thread work p95`).toBeLessThanOrEqual(8);
};

test.afterAll(() => {
  writeFileSync(join(RESULTS_DIR, "polish.json"), JSON.stringify(out, null, 2));
});

const PROVIDERS: readonly FrameProvider[] = ["youtube", ...PROVIDER_CASES.map((c) => c.key), "generic"];

for (const provider of PROVIDERS) {
  test(`polish: 8 avatars walking at once + ${provider}`, async ({ browser, request }) => {
    test.skip(!available.web || !available.server, available.web ? PENDING.server : PENDING.web);
    test.setTimeout(180_000);
    const clients = await joinWithVideo(browser, request, provider, `walk-${provider}`);
    try {
      const [observer] = clients;
      if (!observer) throw new Error("no clients");
      // The walks in from the door are over, and every seat is scrolled into view and settled before the clicks (OME-89).
      await observer.page.waitForTimeout(6000);
      const seats = clients.map((c, i) => c.page.locator(`${site.seat}[data-seat="${String(i)}"]`));
      const moves = walkingTags(observer.page, 2500);
      await Promise.all(clients.map((c, i) => (seats[i] ? clickSettled(c.page, seats[i]) : Promise.reject(new Error("no seat")))));
      const w = await tracedFrames(browser, observer.page, 3000);
      const walking = await moves;
      const k = `walk.${provider}`;
      out[k] = row(w, { walking });
      expect(walking, "the window measures walking, not idle").toBeGreaterThanOrEqual(6);
      for (const c of clients) await expect(c.page.locator(site.roomNotice)).toBeHidden();
      withinBudget(k, row(w, {}));
    } finally {
      await leaveAll(clients);
    }
  });

  test(`polish: 8 avatars emoting at the allowed rate + ${provider}`, async ({ browser, request }) => {
    test.skip(!available.web || !available.server, available.web ? PENDING.server : PENDING.web);
    test.setTimeout(180_000);
    // The observer (client 0) counts the `emoted` frames its socket gets: each one plays over its sender.
    const counter = { emotedAt: [] as number[], rateLimited: 0 };
    const clients = await joinWithVideo(browser, request, provider, `emote-${provider}`, async (context, index) => {
      if (index !== 0) return;
      context.on("page", (page) => {
        page.on("websocket", (ws) => {
          ws.on("framereceived", ({ payload }) => {
            const msg = typeof payload === "string" ? parseServerMessage(payload) : null;
            if (msg === null) return;
            if (msg.type === "emoted") counter.emotedAt.push(Date.now());
            if (msg.type === "error" && msg.code === "rate_limited") counter.rateLimited++;
          });
        });
      });
      await Promise.resolve();
    });
    try {
      const [observer] = clients;
      if (!observer) throw new Error("no clients");
      await observer.page.waitForTimeout(6000);
      for (const c of clients) await c.page.locator("body").click({ position: { x: 2, y: 2 } });
      // Every client presses keys 1–6 in turn, one per EMOTE_EVERY_MS, staggered across the period, through the window.
      const until = { at: Number.POSITIVE_INFINITY };
      let sent = 0;
      const emoting = Promise.all(
        clients.map(async (c, i) => {
          await c.page.waitForTimeout((i * EMOTE_EVERY_MS) / CLIENTS);
          for (let n = 0; Date.now() < until.at; n++) {
            await c.page.keyboard.press(String(((i + n) % 6) + 1));
            sent++;
            await c.page.waitForTimeout(EMOTE_EVERY_MS);
          }
        }),
      );
      await observer.page.waitForTimeout(EMOTE_EVERY_MS);
      const from = Date.now();
      const w = await tracedFrames(browser, observer.page, WINDOW_MS);
      const relayed = counter.emotedAt.filter((t) => t >= from && t < from + WINDOW_MS).length;
      until.at = 0;
      await emoting;
      const k = `emote.${provider}`;
      const expected = Math.floor((CLIENTS * WINDOW_MS) / EMOTE_EVERY_MS);
      out[k] = row(w, { sentTotal: sent, relayedInWindow: relayed, expectedInWindow: expected, everyMs: EMOTE_EVERY_MS, rateLimited: counter.rateLimited });
      expect(relayed, "the window measures emotes animating, at the allowed rate").toBeGreaterThanOrEqual(Math.floor(expected * 0.8));
      expect(counter.rateLimited, "the allowed rate never trips the server bucket").toBe(0);
      for (const c of clients) await expect(c.page.locator(site.roomNotice)).toBeHidden();
      withinBudget(k, row(w, {}));
    } finally {
      await leaveAll(clients);
    }
  });
}
