// Per-provider sync sampling for M2 (OME-131), shared by e2e/provider-sync.e2e.ts and perf/provider-sync.perf.ts.
// Reads only the fake SDKs (OME-121: window.__fakeTwitch, window.__fakeVimeo) and the server, like perf/sync.ts does
// for YouTube. Twitch's getCurrentTime() is a stale cache (research §1.4), so samples use the fakes' true media time.
import { expect } from "@playwright/test";
import type { APIRequestContext, Browser, Page } from "@playwright/test";
import { DEFAULT_ROOM_ID } from "@omega/shared";
import type { Client } from "../e2e/support/room";
import { site } from "../e2e/support/selectors";
import { joinForToken, postShare } from "../e2e/support/share";
import { arrivalSpread, spread, type ArrivalSpread, type ClientSample } from "./spread";
import { roomPlayback, type SpreadMeasurement } from "./sync";

export type FakeProvider = "twitch" | "vimeo";

export interface ProviderCase {
  readonly key: "twitchVod" | "twitchLive" | "vimeo";
  readonly label: string;
  readonly provider: FakeProvider;
  /** What a user pastes; the server canonicalises it. */
  readonly shareUrl: string;
  readonly live: boolean;
}

export const TWITCH_VOD_ID = "1234567890";
export const TWITCH_CHANNEL = "omegatestchannel";
export const VIMEO_ID = "76979871";

// OME-294: the stand-in for a loaded generic embed (ADR 0024), shared by site.perf.ts and chat.perf.ts. The host is routed to a local page
// that repaints every frame (a stand-in for a playing video): a compositor animation plus a full canvas redraw on its
// own main thread each rAF. There is no playback to wait for, the tier isn't synced.
export const GENERIC_HOST = "video.omega-fixture.org";
export const GENERIC_PAGE = `<!doctype html><title>generic</title><style>
  html, body { margin: 0; height: 100%; background: #111; overflow: hidden; }
  div { width: 40%; height: 40%; background: #4a8; animation: m 1s linear infinite alternate; }
  @keyframes m { from { transform: translateX(0) rotate(0); } to { transform: translateX(120%) rotate(180deg); } }
</style><div></div><canvas width="640" height="360"></canvas><script>
  const g = document.querySelector("canvas").getContext("2d");
  const draw = (t) => {
    for (let i = 0; i < 64; i++) { g.fillStyle = "hsl(" + ((t / 10 + i * 5) % 360) + ",60%,50%)"; g.fillRect((i % 8) * 80, Math.floor(i / 8) * 45, 80, 45); }
    window.__genericFrames = (window.__genericFrames || 0) + 1;
    requestAnimationFrame(draw);
  };
  requestAnimationFrame(draw);
</script>`;

export const PROVIDER_CASES: readonly ProviderCase[] = [
  { key: "twitchVod", label: "Twitch VOD", provider: "twitch", shareUrl: `https://www.twitch.tv/videos/${TWITCH_VOD_ID}`, live: false },
  { key: "twitchLive", label: "Twitch live", provider: "twitch", shareUrl: `https://www.twitch.tv/${TWITCH_CHANNEL}`, live: true },
  { key: "vimeo", label: "Vimeo", provider: "vimeo", shareUrl: `https://vimeo.com/${VIMEO_ID}`, live: false },
];

export function providerCase(key: ProviderCase["key"]): ProviderCase {
  const c = PROVIDER_CASES.find((p) => p.key === key);
  if (c === undefined) throw new Error(`no provider case ${key}`);
  return c;
}

/** Share `url` into `roomId` before anyone joins, so every client mounts it (a fresh load at 0, playing). */
export async function shareProvider(request: APIRequestContext, url: string, roomId: string = DEFAULT_ROOM_ID): Promise<void> {
  const member = await joinForToken(roomId, "provider-sharer");
  try {
    expect((await postShare(request, roomId, member.token, url)).status()).toBe(200);
  } finally {
    member.close();
  }
}

/** The fake's own playing flag: Twitch playback "Playing", Vimeo not paused. Null before the SDK loads. */
export const fakePlaying = (page: Page, provider: FakeProvider): Promise<boolean | null> =>
  page.evaluate((p) => {
    if (p === "twitch") {
      const t = window.__fakeTwitch;
      return t?.player ? t.playback === "Playing" : null;
    }
    const v = window.__fakeVimeo;
    return v?.player ? !v.paused : null;
  }, provider);

export async function waitProviderPlaying(clients: readonly Client[], provider: FakeProvider, playing = true): Promise<void> {
  await Promise.all(
    clients.map(async (c) => {
      await expect(c.page.locator(site.sharedVideo)).toBeVisible({ timeout: 15_000 });
      await expect.poll(() => fakePlaying(c.page, provider), { timeout: 15_000, message: `${c.nickname} ${playing ? "playing" : "paused"}` }).toBe(playing);
    }),
  );
}

/** Every client's true media time, each stamped with its own wall-clock time, read in parallel. */
export function sampleProvider(clients: readonly Client[], provider: FakeProvider): Promise<ClientSample[]> {
  return Promise.all(
    clients.map((c) =>
      c.page.evaluate((p) => {
        const actual = p === "twitch" ? window.__fakeTwitch?.currentTime : window.__fakeVimeo?.currentTime;
        if (actual === undefined) throw new Error(`no fake ${p} player`);
        return { t: performance.timeOrigin + performance.now(), actual };
      }, provider),
    ),
  );
}

/** As perf/sync.ts measureSpread, for a Twitch VOD or Vimeo client set. */
export async function measureProviderSpread(browser: Browser, clients: readonly Client[], provider: FakeProvider, roomId: string = DEFAULT_ROOM_ID): Promise<SpreadMeasurement> {
  const samples = await sampleProvider(clients, provider);
  const playback = await roomPlayback(browser, roomId);
  return { ...spread(playback, samples), playback };
}

/** Wall-clock ms of the first `name` command the app sent this client's fake Twitch player at or after `at`. */
const twitchCommandAt = (page: Page, name: "play" | "pause", at: number): Promise<number | null> =>
  page.evaluate(
    ({ name, at }) => {
      const origin = performance.timeOrigin;
      const hit = window.__fakeTwitch?.commands.find((c) => c.name === name && !c.dropped && origin + c.t >= at);
      return hit === undefined ? null : origin + hit.t;
    },
    { name, at },
  );

/**
 * Take `act` (a live pause or play-from-live), then wait for every client's fake Twitch player to receive the
 * matching command; spread and latency come from those command times (perf/spread.ts arrivalSpread).
 */
export interface LiveArrival extends ArrivalSpread {
  /** Wall-clock ms the action was taken. */
  readonly at: number;
  /** Per client, in `clients` order, wall-clock ms. */
  readonly arrivals: readonly number[];
}

export async function measureLiveArrival(clients: readonly Client[], name: "play" | "pause", act: () => Promise<void>): Promise<LiveArrival> {
  const at = Date.now();
  await act();
  const arrivals = await Promise.all(
    clients.map(async (c) => {
      await expect.poll(() => twitchCommandAt(c.page, name, at), { timeout: 5_000, intervals: [50], message: `${c.nickname} got ${name}` }).not.toBeNull();
      // The command log only grows, so the first hit found by the poll is still the first.
      const t = await twitchCommandAt(c.page, name, at);
      if (t === null) throw new Error(`${c.nickname}: no ${name}`);
      return t;
    }),
  );
  return { ...arrivalSpread(at, arrivals), at, arrivals };
}
