// HTTP flood limits through the tunnel proxy (OME-281, ADR 0022, threat model §10 "HTTP floods"): every HTTP route
// counts against a per-client bucket (burst 120, refill 20 per second) keyed by the forwarded address, so one flooding
// client gets `429` + `Retry-After` while everybody else — other addresses, and a single normal page load — is never
// limited. `x-fixture-client` plays the client address. The suite has its own lane (FLOOD_PORTS), so the spent bucket
// of the flooder, and the in-flight pressure, never reach another spec.
import type { BrowserContext, Page, Response } from "@playwright/test";
import { DEFAULT_ROOM_ID } from "@omega/shared";
import { site } from "./support/selectors";
import { FLOOD_PORTS, PUBLIC_ORIGIN, expect, floodTest as test, tunnelRequest } from "./tunnel-support";

const ROOM_URL = `${PUBLIC_ORIGIN}/r/${DEFAULT_ROOM_ID}`;
/** ADR 0022: the per-key HTTP bucket (apps/server/src/http.ts HTTP_BURST / HTTP_PER_SECOND; not exported, so restated here). */
const HTTP_BURST = 120;
const HTTP_PER_SECOND = 20;
/** More than the bucket can ever hold plus what refills while the flood runs. */
const FLOOD_CAP = HTTP_BURST * 4;

/** A distinct synthetic address per call (documentation range), so no two cases share a bucket. */
let nextClient = 1;
const freshClient = (): string => `198.51.100.${String(nextClient++)}`;

const get = (client: string, path = "/healthz") =>
  tunnelRequest({ port: FLOOD_PORTS.proxy, path, headers: { "x-fixture-client": client } });

interface Flood {
  readonly ok: number;
  readonly refused: Awaited<ReturnType<typeof get>> | null;
}

/** Sequential GETs from `client` until the first 429 (or FLOOD_CAP requests). */
async function flood(client: string): Promise<Flood> {
  let ok = 0;
  for (let i = 0; i < FLOOD_CAP; i++) {
    const res = await get(client);
    if (res.status === 429) return { ok, refused: res };
    expect(res.status).toBe(200);
    ok++;
  }
  return { ok, refused: null };
}

/** A context whose every request (subresources and the WebSocket upgrade too) leaves from `client`, recording every response. */
async function watchedFrom(newContext: () => Promise<BrowserContext>, client: string): Promise<{ page: Page; responses: Response[] }> {
  const context = await newContext();
  await context.setExtraHTTPHeaders({ "x-fixture-client": client });
  const page = await context.newPage();
  const responses: Response[] = [];
  page.on("response", (r) => responses.push(r));
  return { page, responses };
}

/** Loads the room page, joins, and waits until the room shows (so HTML, every asset and the WebSocket have all been used). */
async function loadAndJoin(page: Page, nickname: string): Promise<void> {
  await page.goto(ROOM_URL, { waitUntil: "load" });
  await page.locator(site.nicknameInput).fill(nickname);
  await page.locator(site.avatarOption).first().click();
  await page.locator(site.joinButton).click();
  await expect(page.locator(site.room)).toBeVisible();
}

const limited = (responses: readonly Response[]): string[] => responses.filter((r) => r.status() === 429).map((r) => r.url());

/** Keeps hitting an endpoint from `client` for as long as `running()`, so the flood overlaps another client's page load. */
async function floodWhile(client: string, running: () => boolean): Promise<{ ok: number; limited: number }> {
  let ok = 0;
  let limitedCount = 0;
  while (running() || limitedCount === 0) {
    const res = await get(client);
    if (res.status === 429) limitedCount++;
    else if (res.status === 200) ok++;
    else throw new Error(`flooder got ${String(res.status)}`);
    if (ok + limitedCount > FLOOD_CAP * 10) break;
  }
  return { ok, limited: limitedCount };
}

test.describe("HTTP flood limits (ADR 0022)", () => {
  test("one client IP flooding an endpoint gets 429 with a numeric Retry-After once its bucket is spent", async ({ lane }) => {
    expect(lane.siteDir).not.toBe(""); // the lane (server + proxy) is up
    const { ok, refused } = await flood(freshClient());
    expect(refused, `no 429 within ${String(FLOOD_CAP)} requests`).not.toBeNull();
    // The whole burst is served first (a few extra tokens refill while the loop runs), then it is refused.
    expect(ok).toBeGreaterThanOrEqual(HTTP_BURST);
    expect(ok).toBeLessThan(HTTP_BURST + HTTP_PER_SECOND * 5);
    const retryAfter = refused?.headers["retry-after"];
    expect(typeof retryAfter).toBe("string");
    expect(retryAfter).toMatch(/^\d+$/);
    expect(Number(retryAfter)).toBeGreaterThan(0);
  });

  test("a normal page load (HTML, assets, WebSocket) from another address, while a flood is on, is never limited", async ({ newTunnelContext, lane }) => {
    const honest = await watchedFrom(newTunnelContext, freshClient());
    let loading = true;
    const flooding = floodWhile(freshClient(), () => loading);
    try {
      await loadAndJoin(honest.page, "calm-visitor");
    } finally {
      loading = false;
    }
    const flooder = await flooding;
    expect(flooder.limited, "the flooder was limited meanwhile").toBeGreaterThan(0);

    expect(honest.responses.filter((r) => r.url().startsWith(PUBLIC_ORIGIN)).length, "site HTML and its assets were fetched").toBeGreaterThan(2);
    expect(limited(honest.responses)).toEqual([]);
    expect(lane.serverLog()).not.toMatch(/error/i);
  });

  test("a single normal page load, subresources included, from a fresh IP never hits 429", async ({ newTunnelContext }) => {
    const { page, responses } = await watchedFrom(newTunnelContext, freshClient());
    await loadAndJoin(page, "solo-visitor");
    // A reload re-fetches the page too (ADR 0022: the burst covers a load and a few reloads).
    await page.reload({ waitUntil: "load" });
    await expect(page.locator(site.nicknameInput).or(page.locator(site.room))).toBeVisible();
    expect(responses.filter((r) => r.url().startsWith(PUBLIC_ORIGIN)).length).toBeGreaterThan(2);
    expect(limited(responses)).toEqual([]);
  });
});
