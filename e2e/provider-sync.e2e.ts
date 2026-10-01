// M2 provider sync (OME-131): 4 contexts in one room, the real server, clock sync, sync loop and the Twitch and Vimeo
// adapters (OME-125, OME-126) against the fake SDKs (OME-121). Spread = max − min of (expected − actual) 2 s after
// each action, as in sync.e2e.ts; Twitch live has no position, so there it is when the pause / play-from-live landed
// on each client (perf/spread.ts arrivalSpread). Runs in the `e2e-sync` project; every case shares into a room of its own (OME-341).
import { expect, test } from "./support/csp";
import type { BrowserContext, TestInfo } from "@playwright/test";
import { parseServerMessage } from "@omega/shared";
import { PENDING, URLS, available } from "./support/apps";
import { FAKE_VIMEO_SDK } from "./support/network";
import { joinRoom, leaveAll, roomsFor, type Client } from "./support/room";
import { site } from "./support/selectors";
import {
  TWITCH_CHANNEL,
  fakePlaying,
  measureLiveArrival,
  measureProviderSpread,
  providerCase,
  shareProvider,
  waitProviderPlaying,
  type ProviderCase,
} from "../perf/providers";
import { SETTLE_MS, SPREAD_BUDGET_MS, roomPlayback } from "../perf/sync";

const nextRoom = roomsFor("provider-sync");
const CLIENTS = 4;
const LIVE_URL = `https://player.twitch.tv/?channel=${TWITCH_CHANNEL}`;
const livePill = '[data-testid="live-pill"]';
const toLive = '[data-testid="to-live"]';
const seekOnlyHint = '[data-testid="seek-only-hint"]';
const plate = '[data-testid="provider-plate"]';

test.describe.configure({ mode: "serial" });

const first = (clients: readonly Client[]): Client => {
  const [a] = clients;
  if (!a) throw new Error("no clients");
  return a;
};

async function attach(info: TestInfo, name: string, body: unknown): Promise<void> {
  await info.attach(name, { body: JSON.stringify(body, null, 2), contentType: "application/json" });
}

/** Every client's fake Vimeo SDK honours setPlaybackRate, so the adapter nudges instead of only seeking. */
const vimeoRateAllowed = async (context: BrowserContext): Promise<void> => {
  await context.route("https://player.vimeo.com/api/player.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: `${FAKE_VIMEO_SDK}\nwindow.__fakeVimeo.rateAllowed(true);` }),
  );
};

let clients: Client[] = [];
test.afterEach(async () => {
  await leaveAll(clients);
  clients = [];
});

test.describe("M2 provider sync, 4 clients", () => {
  test.fixme(!available.web, PENDING.web);
  test.fixme(!available.server, PENDING.server);
  test.setTimeout(90_000);

  const seekable: { c: ProviderCase; name: string; rate?: true }[] = [
    { c: providerCase("twitchVod"), name: "Twitch VOD (seek-only)" },
    { c: providerCase("vimeo"), name: "Vimeo, rate rejected (seek-only fallback)" },
    { c: providerCase("vimeo"), name: "Vimeo, rate allowed", rate: true },
  ];
  for (const { c, name, rate } of seekable) {
    test(`${name}: play, pause and seek: spread ≤ 500 ms 2 s later`, async ({ browser, request }, info) => {
      const room = nextRoom();
      await shareProvider(request, c.shareUrl, room.id);
      clients = await joinRoom(browser, { roomUrl: room.url, count: CLIENTS, nicknamePrefix: `${c.key}-sync`, ...(rate ? { setup: vimeoRateAllowed } : {}) });
      const a = first(clients);
      await waitProviderPlaying(clients, c.provider);
      await expect(a.page.locator(plate)).toContainText(c.provider === "twitch" ? "Twitch" : "Vimeo");
      await expect(a.page.locator(livePill)).toBeHidden();
      await expect(a.page.locator(site.seek)).toBeVisible();
      // Twitch has no playback rate at all, so its VOD says it syncs by skipping (ADR 0014 §3); so does a Vimeo whose rate probe was rejected (OME-172).
      if (rate) await expect(a.page.locator(seekOnlyHint)).toBeHidden();
      else await expect(a.page.locator(seekOnlyHint)).toBeVisible();

      const results: Record<string, unknown> = {};
      const step = async (action: "pause" | "play" | "seek", act: () => Promise<void>, playing: boolean, position?: number) => {
        await act();
        await a.page.waitForTimeout(SETTLE_MS);
        const m = await measureProviderSpread(browser, clients, c.provider, room.id);
        results[action] = m;
        expect(m.playback.action, action).toBe(action);
        expect(m.playback.playing).toBe(playing);
        if (position !== undefined) expect(m.playback.position).toBeCloseTo(position, 0);
        expect(m.spreadMs, `${action}: drifts ${m.drifts.map((d) => d.toFixed(0)).join(", ")} ms`).toBeLessThanOrEqual(SPREAD_BUDGET_MS);
        for (const cl of clients) expect(await fakePlaying(cl.page, c.provider), cl.nickname).toBe(playing);
      };
      await step("pause", () => a.page.locator(site.playToggle).click(), false);
      await step("play", () => a.page.locator(site.playToggle).click(), true);
      await step("seek", () => a.page.locator(site.seek).fill("120"), true, 120);
      if (rate) {
        // The probe was accepted, so the adapter may nudge: calls beyond the probe are allowed, never required.
        const probes = await a.page.evaluate(() => window.__fakeVimeo?.calls.filter((x) => x.name === "setPlaybackRate").map((x) => x.args) ?? []);
        expect(probes[0]).toEqual([1]);
      }
      await attach(info, "spreads", results);
    });
  }

  test("Twitch VOD: a late joiner is within 500 ms", async ({ browser, request }, info) => {
    const room = nextRoom();
    const c = providerCase("twitchVod");
    await shareProvider(request, c.shareUrl, room.id);
    clients = await joinRoom(browser, { roomUrl: room.url, count: CLIENTS - 1, nicknamePrefix: "tw-early" });
    await waitProviderPlaying(clients, c.provider);
    await first(clients).page.locator(site.seek).fill("300");
    await first(clients).page.waitForTimeout(SETTLE_MS);
    const seeked = await roomPlayback(browser, room.id);
    expect(seeked.action).toBe("seek");

    const late = await joinRoom(browser, { roomUrl: room.url, count: 1, nicknamePrefix: "tw-late" });
    clients.push(...late);
    await waitProviderPlaying(late, c.provider);
    await first(clients).page.waitForTimeout(SETTLE_MS);
    const m = await measureProviderSpread(browser, clients, c.provider, room.id);
    await attach(info, "late-joiner", m);
    expect(m.playback.rev).toBe(seeked.rev);
    expect(m.spreadMs, `drifts ${m.drifts.map((d) => d.toFixed(0)).join(", ")} ms (late joiner last)`).toBeLessThanOrEqual(SPREAD_BUDGET_MS);
  });

  test("Twitch live: pause and play-from-live reach every client within 500 ms; no seek anywhere", async ({ browser, request }, info) => {
    const room = nextRoom();
    const c = providerCase("twitchLive");
    await shareProvider(request, c.shareUrl, room.id);
    clients = await joinRoom(browser, { roomUrl: room.url, count: CLIENTS, nicknamePrefix: "live" });
    const a = first(clients);
    await waitProviderPlaying(clients, c.provider);
    for (const cl of clients) {
      await expect(cl.page.locator(livePill)).toBeVisible();
      await expect(cl.page.locator(site.seek)).toBeHidden();
      await expect(cl.page.locator(toLive)).toBeDisabled();
    }

    const pause = await measureLiveArrival(clients, "pause", () => a.page.locator(site.playToggle).click());
    await waitProviderPlaying(clients, c.provider, false);
    const paused = await roomPlayback(browser, room.id);
    expect([paused.playing, paused.position, paused.action]).toEqual([false, 0, "pause"]);
    for (const cl of clients) await expect(cl.page.locator(site.systemLine).last()).toHaveText(cl === a ? "You paused" : `${a.nickname} paused`);

    // Resuming a live stream is the jump to the live edge, from the dedicated button while the room is paused.
    await expect(a.page.locator(toLive)).toBeEnabled();
    const play = await measureLiveArrival(clients, "play", () => a.page.locator(toLive).click());
    await waitProviderPlaying(clients, c.provider);
    const resumed = await roomPlayback(browser, room.id);
    expect([resumed.playing, resumed.position]).toEqual([true, 0]);

    // Server `at` splits click → server from server → clients.
    const rel = (r: typeof pause, serverAt: number) => ({ latencyMs: r.latencyMs, spreadMs: r.spreadMs, serverMs: serverAt - r.at, clientsMs: r.arrivals.map((t) => Math.round(t - r.at)) });
    await attach(info, "live-arrivals", { pause: rel(pause, paused.at), play: rel(play, resumed.at) });
    for (const [name, r] of [["pause", pause], ["play", play]] as const) {
      expect(r.spreadMs, `${name}: first to last client ${r.spreadMs.toFixed(0)} ms`).toBeLessThanOrEqual(SPREAD_BUDGET_MS);
      expect(r.latencyMs, `${name}: last client ${r.latencyMs.toFixed(0)} ms after the click`).toBeLessThanOrEqual(SPREAD_BUDGET_MS);
    }
    for (const cl of clients) {
      expect(await cl.page.evaluate(() => window.__fakeTwitch?.commands.filter((x) => x.name === "seek").length), cl.nickname).toBe(0);
    }
  });

  test("Twitch live: resuming right after mount still reaches every client within 500 ms", async ({ browser, request }) => {
    const room = nextRoom();
    // OME-170 regression: the loop's own start-up play() must not throttle a new room play (RESEND_MS).
    await shareProvider(request, providerCase("twitchLive").shareUrl, room.id);
    clients = await joinRoom(browser, { roomUrl: room.url, count: CLIENTS, nicknamePrefix: "live-early" });
    const a = first(clients);
    await waitProviderPlaying(clients, "twitch");
    await measureLiveArrival(clients, "pause", () => a.page.locator(site.playToggle).click());
    await expect(a.page.locator(toLive)).toBeEnabled();
    const play = await measureLiveArrival(clients, "play", () => a.page.locator(toLive).click());
    expect(play.latencyMs, `clients ${play.arrivals.map((t) => (t - play.at).toFixed(0)).join(", ")} ms after the click`).toBeLessThanOrEqual(SPREAD_BUDGET_MS);
  });

  test("Twitch live: a forged control with a position is stored at 0 and never seeks a client", async ({ browser, request }) => {
    const room = nextRoom();
    await shareProvider(request, providerCase("twitchLive").shareUrl, room.id);
    clients = await joinRoom(browser, { roomUrl: room.url, count: 2, nicknamePrefix: "live-forge" });
    await waitProviderPlaying(clients, "twitch");
    const before = await roomPlayback(browser, room.id);

    // A raw member that bypasses the site's live transport: pause with a position, then play with another.
    const ws = new WebSocket(`${URLS.server.replace(/^http/, "ws")}/rooms/${room.id}/ws`);
    const errors: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("forger got no snapshot"));
      }, 10_000);
      ws.addEventListener("open", () => {
        ws.send(JSON.stringify({ type: "join", nickname: "forger", avatar: 0 }));
      });
      ws.addEventListener("message", (ev: MessageEvent<unknown>) => {
        const msg = typeof ev.data === "string" ? parseServerMessage(ev.data) : null;
        if (msg?.type === "error") errors.push(msg.code);
        if (msg?.type === "snapshot") {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    try {
      ws.send(JSON.stringify({ type: "control", url: LIVE_URL, playing: false, position: 300 }));
      await expect.poll(async () => (await roomPlayback(browser, room.id)).rev, { timeout: 5_000 }).toBeGreaterThan(before.rev);
      const p1 = await roomPlayback(browser, room.id);
      expect([p1.playing, p1.position]).toEqual([false, 0]);
      ws.send(JSON.stringify({ type: "control", url: LIVE_URL, playing: true, position: 1800 }));
      await expect.poll(async () => (await roomPlayback(browser, room.id)).playing, { timeout: 5_000 }).toBe(true);
      expect((await roomPlayback(browser, room.id)).position).toBe(0);
      await waitProviderPlaying(clients, "twitch");
      await first(clients).page.waitForTimeout(1000);
    } finally {
      ws.close();
    }
    expect(errors).toEqual([]);
    for (const cl of clients) {
      expect(await cl.page.evaluate(() => window.__fakeTwitch?.commands.filter((x) => x.name === "seek").length), cl.nickname).toBe(0);
    }
  });
});
