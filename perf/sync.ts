// Playwright-side sampling for sync.spread (OME-90), shared by e2e/sync.e2e.ts and perf/sync.perf.ts.
// Works against dev and production builds alike: it reads only the fake player (window.__fakeYt) and the server.
import { expect } from "@playwright/test";
import type { APIRequestContext, Browser, Page } from "@playwright/test";
import { DEFAULT_ROOM_ID, parseServerMessage, type PlaybackState } from "@omega/shared";
import { rawSnapshot } from "../e2e/support/bots";
import { EMBED_URL } from "../e2e/support/network";
import type { Client } from "../e2e/support/room";
import { site } from "../e2e/support/selectors";
import { joinForToken, postShare } from "../e2e/support/share";
import { spread, type ClientSample, type Spread } from "./spread";

/** docs/perf-budgets.md: Sync row. */
export const SPREAD_BUDGET_MS = 500;
/** Spread is measured this long after each action. */
export const SETTLE_MS = 2000;
/** YT.PlayerState */
export const PLAYING = 1;
export const PAUSED = 2;

export const fakeState = (page: Page): Promise<number | null> => page.evaluate(() => window.__fakeYt?.state ?? null);

/** Share the test video into `roomId` (a fresh `load` at 0, playing). Joins as a member for a share token (OME-128); waits out 429s. */
export async function shareVideo(request: APIRequestContext, roomId: string = DEFAULT_ROOM_ID): Promise<void> {
  const member = await joinForToken(roomId, "sharer");
  try {
    const res = await postShare(request, roomId, member.token, EMBED_URL);
    expect(res.status()).toBe(200);
  } finally {
    member.close();
  }
}

export async function waitPlaying(clients: readonly Client[]): Promise<void> {
  await Promise.all(
    clients.map(async (c) => {
      await expect(c.page.locator(site.sharedVideo)).toBeVisible({ timeout: 15_000 });
      await expect.poll(() => fakeState(c.page), { timeout: 15_000, message: `${c.nickname} playing` }).toBe(PLAYING);
    }),
  );
}

/** Every client's player, each stamped with its own wall-clock time, read in parallel. */
export function sampleClients(clients: readonly Client[]): Promise<ClientSample[]> {
  return Promise.all(
    clients.map((c) =>
      c.page.evaluate(() => {
        const actual = window.__fakeYt?.currentTime;
        if (actual === undefined) throw new Error("no fake player");
        return { t: performance.timeOrigin + performance.now(), actual };
      }),
    ),
  );
}

/** The room's playback as the server holds it (a throwaway observer's snapshot). */
export async function roomPlayback(browser: Browser, roomId: string = DEFAULT_ROOM_ID): Promise<PlaybackState> {
  const msg = parseServerMessage(await rawSnapshot(browser, roomId));
  if (msg?.type !== "snapshot") throw new Error("no snapshot");
  const p = msg.room.playback;
  if (p === undefined || p === null) throw new Error("room has no playback");
  return p;
}

export interface SpreadMeasurement extends Spread {
  readonly playback: PlaybackState;
}

/**
 * Sample every client now, then read the room state they're compared against. Callers check `playback.action`,
 * so a change landing in between shows up as a wrong action rather than a bogus spread.
 */
export async function measureSpread(browser: Browser, clients: readonly Client[], roomId: string = DEFAULT_ROOM_ID): Promise<SpreadMeasurement> {
  const samples = await sampleClients(clients);
  const playback = await roomPlayback(browser, roomId);
  return { ...spread(playback, samples), playback };
}
