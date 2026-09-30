// M3 abuse suite (OME-191, threat model §8 and gap table): the WS and HTTP limiters of W (OME-187) and H (OME-188)
// and the web client's answers to them (C, OME-189), driven through the local reverse proxy (e2e/fixtures/proxy.ts)
// with `x-fixture-client` playing many addresses. Every case ends by checking that an honest pair, in the room the
// whole time from addresses of their own, still stays in sync. It runs on a lane of its own (ABUSE_PORTS), so the
// limits it spends never reach the tunnel specs. Serial: one server, one lobby, shared limits.
import type { Browser, BrowserContext, Page, WebSocketRoute } from "@playwright/test";
import { CLOSE_CODES, DEFAULT_ROOM_ID, RATE_LIMITED_RECONNECT_MS, SHARE_TOKEN_STORAGE_KEY, parseServerMessage } from "@omega/shared";
import { WATCH_URL } from "./support/network";
import { site } from "./support/selectors";
import { watchCsp } from "./support/csp";
import { ABUSE_PORTS, PUBLIC_ORIGIN, abuseTest as test, expect, passTunnelHosts, tunnelRequest, tunnelUpgrade } from "./tunnel-support";

const ROOM = DEFAULT_ROOM_ID;
const ROOM_URL = `${PUBLIC_ORIGIN}/r/${ROOM}`;
const WS_PATH = `/rooms/${ROOM}/ws`;
const PUBLIC_WS = `wss://omega.test${WS_PATH}`;
const PORT = ABUSE_PORTS.proxy;
/** How fast a play/pause must reach the other honest client (docs/perf-budgets.md, M1b sync). */
const SYNC_MS = 500;
/** YT.PlayerState */
const PLAYING = 1;
const PAUSED = 2;
/** Server-private limits under test (apps/server/src/ws.ts, threat model §6). */
const UPGRADE_BURST = 10;
const MEMBERS_PER_KEY = 5;

/** A distinct synthetic address per call, so no two cases share a limiter bucket by accident. */
let nextClient = 1;
const attacker = (): string => `203.0.113.${String(nextClient++)}`;

interface Honest {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly nickname: string;
}

const fakeState = (page: Page): Promise<number | null> => page.evaluate(() => window.__fakeYt?.state ?? null);

/** A watched context on the lane's browser whose every request (WebSocket upgrades too) leaves from `client`. */
async function contextFrom(browser: Browser, client: string): Promise<BrowserContext> {
  const context = await watchCsp(await browser.newContext({ ignoreHTTPSErrors: true }));
  await passTunnelHosts(context);
  await context.setExtraHTTPHeaders({ "x-fixture-client": client });
  return context;
}

/** Fills the landing and presses join; resolves once the room or a refusal card shows. */
async function enter(page: Page, nickname: string): Promise<void> {
  if (!page.url().startsWith(ROOM_URL)) await page.goto(ROOM_URL);
  await page.locator(site.nicknameInput).fill(nickname);
  await page.locator(site.avatarOption).first().click();
  await page.locator(site.joinButton).click();
  await expect(page.locator(`${site.room}, ${site.roomRefused}:visible`).first()).toBeVisible();
}

/** Joins the lobby over a raw WebSocket opened by `page` (so from its address) and keeps it open; resolves with the first reply. */
async function rawJoin(page: Page, nickname: string): Promise<string> {
  return page.evaluate(
    ({ url, nickname }) =>
      new Promise<string>((resolve, reject) => {
        const ws = new WebSocket(url);
        const kept = (window as unknown as { omegaSockets?: WebSocket[] }).omegaSockets ?? [];
        Object.assign(window, { omegaSockets: [...kept, ws] });
        ws.addEventListener("open", () => {
          ws.send(JSON.stringify({ type: "join", nickname, avatar: 0 }));
        });
        ws.addEventListener("message", (ev: MessageEvent<unknown>) => {
          if (typeof ev.data === "string") resolve(ev.data);
        });
        ws.addEventListener("error", () => {
          reject(new Error("websocket error"));
        });
      }),
    { url: PUBLIC_WS, nickname },
  );
}

/** Shares `WATCH_URL` from `page` with the member token the site keeps in sessionStorage (ADR 0015). */
async function shareFromSite(page: Page): Promise<number> {
  return page.evaluate(
    async ({ key, url, room }) => {
      const raw = sessionStorage.getItem(key);
      const rec: unknown = raw === null ? null : JSON.parse(raw);
      const token = typeof rec === "object" && rec !== null && "token" in rec ? rec.token : null;
      if (typeof token !== "string") throw new Error("no share token in sessionStorage");
      const res = await fetch(`/rooms/${room}/share`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ url }),
      });
      return res.status;
    },
    { key: SHARE_TOKEN_STORAGE_KEY, url: WATCH_URL, room: ROOM },
  );
}

/** Honest A presses play/pause; B's player follows within SYNC_MS. Returns the measured delay. */
async function expectInSync(a: Honest, b: Honest): Promise<number> {
  const before = await fakeState(b.page);
  const target = before === PLAYING ? PAUSED : PLAYING;
  await expect(a.page.locator(site.connectionStatus)).toHaveText("");
  await expect(b.page.locator(site.connectionStatus)).toHaveText("");
  const t0 = Date.now();
  await a.page.locator(site.playToggle).click();
  await expect.poll(() => fakeState(b.page), { timeout: SYNC_MS, intervals: [10] }).toBe(target);
  const took = Date.now() - t0;
  // Both still see each other.
  await expect(b.page.locator(site.nicknameTag, { hasText: a.nickname })).toBeVisible();
  await expect(a.page.locator(site.nicknameTag, { hasText: b.nickname })).toBeVisible();
  return took;
}

test.describe.configure({ mode: "serial" });

test.describe("abuse through the reverse proxy; an honest pair stays in sync", () => {
  let a: Honest;
  let b: Honest;
  const delays: number[] = [];

  test.beforeAll(async ({ lane, tunnelBrowser }) => {
    expect(lane.proxy.port).toBe(PORT);
    const honest = async (nickname: string, client: string): Promise<Honest> => {
      const context = await contextFrom(tunnelBrowser, client);
      const page = await context.newPage();
      await enter(page, nickname);
      await expect(page.locator(site.room)).toBeVisible();
      return { context, page, nickname };
    };
    a = await honest("honest-a", "198.51.100.10");
    b = await honest("honest-b", "198.51.100.20");
    expect(await shareFromSite(a.page)).toBe(200);
    for (const c of [a, b]) await expect.poll(() => fakeState(c.page), { timeout: 10_000 }).toBe(PLAYING);
  });

  test.afterAll(async () => {
    await Promise.all([a, b].map((c) => c.context.close()));
  });

  test.afterEach(async ({}, testInfo) => {
    delays.push(await expectInSync(a, b));
    await testInfo.attach("honest-sync-ms.json", { body: JSON.stringify(delays), contentType: "application/json" });
  });

  test("upgrade limiter keyed by the XFF entry the proxy appends: a reconnect loop gets 429 + Retry-After, other addresses don't", async () => {
    const churner = attacker();
    const statuses: number[] = [];
    // One at a time, each closed at once: the per-address connection cap (10 open) never trips, only the rate does.
    for (let i = 0; i < UPGRADE_BURST; i++) {
      const u = await tunnelUpgrade({ port: PORT, path: WS_PATH, headers: { "x-fixture-client": churner } });
      statuses.push(u.status);
      u.close();
    }
    expect(statuses).toEqual(Array<number>(UPGRADE_BURST).fill(101));
    const refused = await tunnelUpgrade({ port: PORT, path: WS_PATH, headers: { "x-fixture-client": churner, "x-forwarded-for": attacker() } });
    refused.close();
    expect(refused.status).toBe(429);
    expect(refused.body).toBe("reconnecting too fast");
    expect(Number(refused.headers["retry-after"])).toBeGreaterThanOrEqual(1);

    const other = await tunnelUpgrade({ port: PORT, path: WS_PATH, headers: { "x-fixture-client": attacker() } });
    other.close();
    expect(other.status).toBe(101);
  });

  test("per-address member cap: the sixth member from one address sees the too_many_members card", async ({ tunnelBrowser }) => {
    const squatter = attacker();
    const context = await contextFrom(tunnelBrowser, squatter);
    try {
      const raw = await context.newPage();
      await raw.goto(`${PUBLIC_ORIGIN}/healthz`);
      for (let i = 0; i < MEMBERS_PER_KEY; i++) {
        expect(parseServerMessage(await rawJoin(raw, `squat-${String(i)}`))?.type).toBe("snapshot");
      }
      const page = await context.newPage();
      await enter(page, "squat-site");
      const card = page.locator(site.roomRefused);
      await expect(card).toBeVisible();
      await expect(card).toHaveAttribute("data-code", "too_many_members");
      await expect(page.locator(site.room)).toBeHidden();
      // The connection stopped: no reconnect loop against the cap.
      await page.waitForTimeout(1_500);
      await expect(card).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("nickname_taken: a look-alike of an honest member's name gets the card; another name then joins", async ({ tunnelBrowser }) => {
    const context = await contextFrom(tunnelBrowser, attacker());
    try {
      const page = await context.newPage();
      // Fullwidth and upper case: the same nicknameKey as "honest-a" after NFKC and case folding.
      await enter(page, "ＨＯＮＥＳＴ-Ａ");
      const card = page.locator(site.roomRefused);
      await expect(card).toBeVisible();
      await expect(card).toHaveAttribute("data-code", "nickname_taken");
      await expect(page.locator(site.room)).toBeHidden();

      await page.locator(site.roomRefusedAction).click();
      await enter(page, "fresh-name");
      await expect(page.locator(site.room)).toBeVisible();
      await expect(a.page.locator(site.nicknameTag, { hasText: "fresh-name" })).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("flooding the socket closes it with 4029; the web client shows it and waits the rate-limited backoff before rejoining", async ({ tunnelBrowser }) => {
    test.slow();
    const context = await contextFrom(tunnelBrowser, attacker());
    const opened: number[] = [];
    const closes: { code: number | undefined; at: number }[] = [];
    const servers: WebSocketRoute[] = [];
    try {
      const page = await context.newPage();
      await page.routeWebSocket(/\/rooms\/[^/]+\/ws$/, (ws) => {
        opened.push(Date.now());
        const server = ws.connectToServer();
        servers.push(server);
        server.onClose((code, reason) => {
          closes.push({ code, at: Date.now() });
          void ws.close(code === undefined ? {} : { code, reason: reason ?? "" });
        });
      });
      await enter(page, "flooder");
      await expect(page.locator(site.room)).toBeVisible();
      await expect(page.locator(site.connectionStatus)).toHaveText("");
      expect(opened).toHaveLength(1);

      // The page's own socket sends 80 chats at once: 5 pass the chat bucket, then 50 drops in a row close it.
      const [server] = servers;
      if (server === undefined) throw new Error("the room socket was not routed");
      for (let i = 0; i < 80; i++) server.send(JSON.stringify({ type: "chat", text: `flood ${String(i)}` }));

      await expect.poll(() => closes[0]?.code, { timeout: 5_000 }).toBe(CLOSE_CODES.RATE_LIMITED);
      await expect(page.locator(site.connectionStatus)).toHaveText("Connection lost, reconnecting…");
      await expect.poll(() => opened.length, { timeout: RATE_LIMITED_RECONNECT_MS + 5_000, intervals: [100] }).toBe(2);
      const waited = (opened[1] ?? 0) - (closes[0]?.at ?? 0);
      expect(waited).toBeGreaterThanOrEqual(RATE_LIMITED_RECONNECT_MS - 250);
      await expect(page.locator(site.connectionStatus)).toHaveText("");
      await expect(a.page.locator(site.nicknameTag, { hasText: "flooder" })).toBeVisible();
      test.info().annotations.push({ type: "4029 backoff", description: `${String(waited)} ms` });
    } finally {
      await context.close();
    }
  });

  test("share spam: the room refuses a video-switch war with 429, Retry-After and retryAfterMs", async ({ tunnelBrowser }) => {
    const spammer = attacker();
    const context = await contextFrom(tunnelBrowser, spammer);
    try {
      const page = await context.newPage();
      await page.goto(`${PUBLIC_ORIGIN}/healthz`);
      const joined = parseServerMessage(await rawJoin(page, "spammer"));
      if (joined?.type !== "snapshot" || joined.shareToken === undefined) throw new Error("expected a snapshot with a share token");
      const token = joined.shareToken;
      const statuses: number[] = [];
      let refused: Awaited<ReturnType<typeof tunnelRequest>> | null = null;
      // The honest share spent one of the room's 2; a spoofed XFF on each try changes nothing.
      for (let i = 0; i < 3 && refused === null; i++) {
        const r = await tunnelRequest({
          port: PORT,
          method: "POST",
          path: `/rooms/${ROOM}/share`,
          headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-fixture-client": spammer, "x-forwarded-for": attacker() },
          body: JSON.stringify({ url: WATCH_URL }),
        });
        statuses.push(r.status);
        if (r.status === 429) refused = r;
      }
      expect(statuses.slice(0, -1).every((s) => s === 200)).toBe(true);
      expect(refused?.status).toBe(429);
      expect(Number(refused?.headers["retry-after"])).toBeGreaterThanOrEqual(1);
      expect(JSON.parse(refused?.body ?? "{}")).toMatchObject({ ok: false, error: { code: "rate_limited", retryAfterMs: expect.any(Number) } });
      // The honest pair got the accepted switch and plays it together.
      for (const c of [a, b]) await expect.poll(() => fakeState(c.page), { timeout: 10_000 }).toBe(PLAYING);
    } finally {
      await context.close();
    }
  });
});
