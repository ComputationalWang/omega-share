// Part B of the M3 real-world checklist (OME-194, docs/qa/m3-real-world.md): light versions of the fixture abuse suite
// (e2e/abuse.e2e.ts, apps/server/test/abuse.test.ts, share-token.test.ts) over a real public tunnel, plus zero CSP
// violations with the real YouTube / Twitch / Vimeo players under the strict CSP. Skipped unless OMEGA_REAL_TUNNEL_ORIGIN
// is set (the operator starts the tunnel and a tunnel-mode server, as for real-tunnel.real.ts).
// Over a real tunnel every client on this machine is one address (the XFF entry ngrok appends), the honest pair too. So
// volumes stay small, the cases run in an order that leaves the per-address buckets room, and each case ends by
// checking that the honest pair still syncs.
import { randomBytes } from "node:crypto";
import { request as httpsRequest } from "node:https";
import type { Socket } from "node:net";
import type { Browser, BrowserContext, Frame, Page } from "@playwright/test";
import { CLOSE_CODES, DEFAULT_ROOM_ID, MAX_CLIENT_MESSAGE_BYTES, SHARE_TOKEN_STORAGE_KEY, parseServerMessage } from "@omega/shared";
import { expect, test, watchCsp } from "../support/csp";
import { site } from "../support/selectors";
import { REAL, providerFrame, twitchVodUrl, vimeoUrl, waitMediaPlaying } from "./providers";
import { BASELINE_ID, embedUrl, record, requireVirtualDisplay, sampleVideo, shot, waitVideoPlaying, ytFrame } from "./real";

test.beforeAll(requireVirtualDisplay);

const ORIGIN = process.env["OMEGA_REAL_TUNNEL_ORIGIN"]?.replace(/\/$/, "");
test.skip(ORIGIN === undefined, "set OMEGA_REAL_TUNNEL_ORIGIN to the public https origin of a running tunnel (docs/qa/m3-real-world.md)");
test.describe.configure({ mode: "serial" });
test.setTimeout(240_000);

const origin = (): string => {
  if (ORIGIN === undefined) throw new Error("no tunnel origin");
  return ORIGIN;
};
const ROOM = DEFAULT_ROOM_ID;
const ROOM_PATH = `/r/${ROOM}`;
const SHARE_PATH = `/rooms/${ROOM}/share`;
const WS_PATH = `/rooms/${ROOM}/ws`;
const NGROK = ORIGIN !== undefined && /\.ngrok(-free)?\.(app|dev|io)$/.test(new URL(ORIGIN).hostname);
const SKIP_WARNING: Record<string, string> = NGROK ? { "ngrok-skip-browser-warning": "1" } : {};
/** docs/perf-budgets.md, M1b sync: a play/pause reaches the other member within this. */
const SYNC_MS = 500;
/** Server-private limits (apps/server/src/ws.ts, threat model §6), as in e2e/abuse.e2e.ts. */
const MEMBERS_PER_KEY = 5;
const HOSTILE = `<img src=x onerror="window.__pwned=1">`;

/** A watched context past ngrok's interstitial; only requests to the tunnel get the header (YouTube breaks with it). */
async function tunnelContext(b: Browser): Promise<BrowserContext> {
  const context = await watchCsp(await b.newContext());
  if (NGROK) await context.route(`${origin()}/**`, (route) => route.continue({ headers: { ...route.request().headers(), ...SKIP_WARNING } }));
  return context;
}

interface Member {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly nickname: string;
}

async function enterRoom(context: BrowserContext, nickname: string): Promise<Member> {
  const page = await context.newPage();
  await page.goto(`${origin()}${ROOM_PATH}`);
  await page.locator(site.nicknameInput).fill(nickname);
  await page.locator(site.avatarOption).first().click();
  await page.locator(site.joinButton).click();
  await page.locator(site.room).waitFor();
  return { context, page, nickname };
}

async function tokenOf(page: Page): Promise<string> {
  await expect.poll(() => page.evaluate((k) => sessionStorage.getItem(k), SHARE_TOKEN_STORAGE_KEY), { timeout: 10_000 }).not.toBeNull();
  const rec: unknown = JSON.parse((await page.evaluate((k) => sessionStorage.getItem(k), SHARE_TOKEN_STORAGE_KEY)) ?? "null");
  if (typeof rec !== "object" || rec === null || !("token" in rec) || typeof rec.token !== "string") throw new Error("no share token record");
  return rec.token;
}

interface Reply {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: string;
}

/** A plain HTTPS request to the public origin, from outside any browser (so no Origin unless given). */
function publicRequest(method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Reply> {
  const u = new URL(path, origin());
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      { host: u.hostname, path: u.pathname, method, agent: false, headers: { ...SKIP_WARNING, ...headers, ...(body === undefined ? {} : { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) }) } },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (text += c));
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text });
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

const share = (token: string, url: string, headers: Record<string, string> = {}): Promise<Reply> =>
  publicRequest("POST", SHARE_PATH, { authorization: `Bearer ${token}`, ...headers }, JSON.stringify({ url }));

/** Shares as `token`, waiting out the room's switch limit (2, then one per 10 s) the way a patient member would. */
async function shareWaiting(token: string, url: string): Promise<number> {
  for (let i = 0; i < 8; i++) {
    const r = await share(token, url);
    if (r.status !== 429) return r.status;
    await new Promise((res) => setTimeout(res, Number(r.headers["retry-after"] ?? "3") * 1000 + 250));
  }
  return 429;
}

/** A raw WebSocket upgrade on the public origin; an accepted socket stays open, unjoined, until `close()`. */
function publicUpgrade(headers: Record<string, string> = {}): Promise<Reply & { readonly close: () => void }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest({
      host: new URL(origin()).hostname,
      path: WS_PATH,
      agent: false,
      headers: { ...SKIP_WARNING, connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": randomBytes(16).toString("base64"), ...headers },
    });
    req.on("upgrade", (res, socket: Socket) => {
      resolve({ status: res.statusCode ?? 101, headers: res.headers, body: "", close: () => socket.destroy() });
    });
    req.on("response", (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (body += c));
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body, close: () => req.destroy() });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

/**
 * From `page` (a tunnel-origin page, so the browser sends our Origin): opens a socket, optionally joins, sends `frames`,
 * and resolves with every reply and the close code once `waitMs` has passed or the socket closed. `keep` leaves it open.
 */
async function rawSocket(page: Page, opts: { join?: string; frames?: string[]; waitMs?: number; keep?: boolean }): Promise<{ replies: string[]; closed: number | null }> {
  return page.evaluate(
    ({ url, join, frames, waitMs, keep }) =>
      new Promise<{ replies: string[]; closed: number | null }>((resolve) => {
        const ws = new WebSocket(url);
        const replies: string[] = [];
        let closed: number | null = null;
        const done = () => {
          if (!keep && closed === null) ws.close();
          resolve({ replies, closed });
        };
        ws.addEventListener("open", () => {
          if (join !== undefined) ws.send(JSON.stringify({ type: "join", nickname: join, avatar: 0 }));
          for (const f of frames) ws.send(f);
        });
        ws.addEventListener("message", (ev: MessageEvent<unknown>) => {
          if (typeof ev.data === "string") replies.push(ev.data);
        });
        ws.addEventListener("close", (ev) => {
          closed = ev.code;
          done();
        });
        if (keep) Object.assign(window, { omegaKept: [...((window as unknown as { omegaKept?: WebSocket[] }).omegaKept ?? []), ws] });
        setTimeout(done, waitMs);
      }),
    { url: `${origin().replace(/^https/, "wss")}${WS_PATH}`, join: opts.join, frames: opts.frames ?? [], waitMs: opts.waitMs ?? 3_000, keep: opts.keep ?? false },
  );
}

const types = (replies: readonly string[]): string[] => replies.map((r) => { const m = parseServerMessage(r); return m === null ? "?" : m.type === "error" ? `error:${m.code}` : m.type; });

test.describe("M3 abuse over the real tunnel; an honest pair stays in sync", () => {
  let a: Member;
  let b: Member;
  let attacker: BrowserContext;
  let attackPage: Page;
  let fa: Frame;
  let fb: Frame;
  const honest: { a: number; b: number; spread: number }[] = [];
  const results: Record<string, unknown> = {};

  /**
   * A presses play/pause; both real YouTube <video>s follow. Returns each one's arrival (ms after the click) and the
   * spread between them, which is what the Sync budget bounds (docs/perf-budgets.md). Over a tunnel both arrivals
   * include the round trip, so only the spread is asserted.
   */
  async function honestSync(): Promise<{ a: number; b: number; spread: number }> {
    const before = (await sampleVideo(fb))?.paused ?? false;
    const t0 = Date.now();
    await a.page.locator(site.playToggle).click();
    const at: (number | null)[] = [null, null];
    while (Date.now() - t0 < 5_000 && at.some((x) => x === null)) {
      const s = await Promise.all([sampleVideo(fa), sampleVideo(fb)]);
      s.forEach((x, i) => {
        if (at[i] === null && x !== null && x.paused === !before) at[i] = Date.now() - t0;
      });
      await new Promise((r) => setTimeout(r, 10));
    }
    const [ta, tb] = at;
    if (ta == null || tb == null) throw new Error(`honest pair didn't follow: ${JSON.stringify(at)}`);
    const r = { a: ta, b: tb, spread: Math.abs(ta - tb) };
    honest.push(r);
    expect(r.spread, "honest pair: spread within the Sync budget").toBeLessThanOrEqual(SYNC_MS);
    if (before) await Promise.all([waitVideoPlaying(fa), waitVideoPlaying(fb)]);
    return r;
  }

  test.beforeAll(async ({ browser }) => {
    a = await enterRoom(await tunnelContext(browser), "honest-a");
    b = await enterRoom(await tunnelContext(browser), "honest-b");
    attacker = await tunnelContext(browser);
    attackPage = await attacker.newPage();
    await attackPage.goto(`${origin()}/healthz`);
  });

  test.afterAll(async () => {
    record("m3-abuse", { origin: NGROK ? "ngrok (host withheld)" : "tunnel", honestSyncMs: honest, ...results });
    await Promise.all([a.context.close(), b.context.close(), attacker.close()]);
  });

  test("B0 · zero CSP violations: real YouTube, Twitch and Vimeo play in both browsers under the strict CSP", async ({ csp }) => {
    const token = await tokenOf(a.page);
    const header = (await publicRequest("GET", ROOM_PATH)).headers["content-security-policy"];
    const played: Record<string, string> = {};
    expect(await shareWaiting(token, twitchVodUrl(REAL.twitchVod))).toBe(200);
    const [ta, tb] = [await providerFrame(a.page, "twitch", `v${REAL.twitchVod}`), await providerFrame(b.page, "twitch", `v${REAL.twitchVod}`)];
    const twitchAds = await Promise.all([waitMediaPlaying(a, ta), waitMediaPlaying(b, tb)]);
    played["twitch"] = "playing";
    expect(await shareWaiting(token, vimeoUrl(REAL.vimeo))).toBe(200);
    const [va, vb] = [await providerFrame(a.page, "vimeo", REAL.vimeo), await providerFrame(b.page, "vimeo", REAL.vimeo)];
    await Promise.all([waitMediaPlaying(a, va), waitMediaPlaying(b, vb)]);
    played["vimeo"] = "playing";
    // YouTube last: the honest checks below run on it.
    expect(await shareWaiting(token, embedUrl(BASELINE_ID))).toBe(200);
    [fa, fb] = [await ytFrame(a.page, BASELINE_ID), await ytFrame(b.page, BASELINE_ID)];
    await Promise.all([waitVideoPlaying(fa), waitVideoPlaying(fb)]);
    played["youtube"] = "playing";
    await a.page.waitForTimeout(2_000);
    await Promise.all([shot(a.page, "m3-abuse-b0-a"), shot(b.page, "m3-abuse-b0-b")]);
    results["B0"] = { cspHeader: typeof header === "string" ? header : null, played, twitchAds: twitchAds.map((t) => t.length), enforced: csp.enforced.length, console: csp.console.length, thirdParty: csp.thirdParty.map((v) => `${v.documentURI} ${v.effectiveDirective} ${v.blockedURI}`) };
    expect(typeof header === "string" && header.includes("frame-src")).toBe(true);
    expect(csp.enforced, "no enforced violation in our documents").toEqual([]);
    expect(csp.console, "no CSP console error").toEqual([]);
    results["B0-honest"] = await honestSync();
  });

  test("B1 · hostile name and chat: the join is refused as bad_message, the chat renders as text", async () => {
    const joined = await rawSocket(attackPage, { join: HOSTILE, waitMs: 3_000 });
    const text = `${HOSTILE} <script>window.__pwned=2</script>`;
    await a.page.locator(site.chatInput).fill(text);
    await a.page.locator(site.chatInput).press("Enter");
    const msg = b.page.locator(site.chatMessage).filter({ hasText: "onerror" }).last();
    await expect(msg).toBeVisible({ timeout: 10_000 });
    const rendered = { text: await msg.textContent(), imgs: await msg.locator("img, script").count(), pwned: await b.page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned ?? null) };
    const hostileTag = await b.page.locator(site.nicknameTag, { hasText: "onerror" }).count();
    results["B1"] = { joinReplies: types(joined.replies), closed: joined.closed, rendered, hostileTag };
    expect(types(joined.replies)).toEqual(["error:bad_message"]);
    expect(hostileTag).toBe(0);
    expect(rendered.imgs).toBe(0);
    expect(rendered.pwned).toBeNull();
    expect(rendered.text).toContain("<img");
    results["B1-honest"] = await honestSync();
  });

  test("B2 · oversize frame: a frame over 4 KB closes that socket (1006), the server stays up", async () => {
    const big = await rawSocket(attackPage, { frames: ["x".repeat(MAX_CLIENT_MESSAGE_BYTES + 1)], waitMs: 5_000 });
    const health = await publicRequest("GET", "/healthz");
    results["B2"] = { closed: big.closed, replies: types(big.replies), health: health.status };
    expect(big.closed).toBe(1006);
    expect(health.status).toBe(200);
    results["B2-honest"] = await honestSync();
  });

  test("B2b · message flood: 80 chats at once close that socket with 4029 (rate limited)", async () => {
    const chats = Array.from({ length: 80 }, (_, i) => JSON.stringify({ type: "chat", text: `flood ${String(i)}` }));
    const flood = await rawSocket(attackPage, { join: "flooder", frames: chats, waitMs: 8_000 });
    results["B2b"] = { closed: flood.closed, replies: [...new Set(types(flood.replies))] };
    expect(flood.closed).toBe(CLOSE_CODES.RATE_LIMITED);
    expect(types(flood.replies)).toContain("error:rate_limited");
    results["B2b-honest"] = await honestSync();
  });

  test("B3 · share-token replay: a live token from a foreign Origin is 403; after its member leaves it is 401", async () => {
    const page = await attacker.newPage();
    await page.goto(`${origin()}/healthz`);
    const joined = await rawSocket(page, { join: "replayer", keep: true, waitMs: 2_000 });
    const snap = parseServerMessage(joined.replies[0] ?? "");
    if (snap?.type !== "snapshot" || snap.shareToken === undefined) throw new Error(`expected a snapshot, got ${types(joined.replies).join(",")}`);
    const token = snap.shareToken;
    const foreign = await share(token, embedUrl(BASELINE_ID), { origin: "https://example.com" });
    await page.close(); // the member leaves: its token dies with the socket (T-02)
    await a.page.waitForTimeout(1_500);
    const replay = await share(token, embedUrl(BASELINE_ID));
    results["B3"] = { foreignOrigin: foreign.status, afterLeave: replay.status, afterLeaveBody: replay.body };
    expect(foreign.status).toBe(403);
    expect(replay.status).toBe(401);
    expect(JSON.parse(replay.body)).toMatchObject({ ok: false, error: { code: "unauthorized" } });
    results["B3-honest"] = await honestSync();
  });

  test("B4 · share spam: a video-switch war gets 429 with Retry-After and retryAfterMs; a spoofed XFF changes nothing", async () => {
    const page = await attacker.newPage();
    await page.goto(`${origin()}/healthz`);
    const joined = await rawSocket(page, { join: "spammer", keep: true, waitMs: 2_000 });
    const snap = parseServerMessage(joined.replies[0] ?? "");
    if (snap?.type !== "snapshot" || snap.shareToken === undefined) throw new Error(`expected a snapshot, got ${types(joined.replies).join(",")}`);
    const statuses: number[] = [];
    let refused: Reply | null = null;
    // The same video every time, so the honest pair keeps playing it: a switch is a switch to the limiter.
    for (let i = 0; i < 4 && refused === null; i++) {
      const r = await share(snap.shareToken, embedUrl(BASELINE_ID), { "x-forwarded-for": `198.51.100.${String(i + 1)}` });
      statuses.push(r.status);
      if (r.status === 429) refused = r;
    }
    await page.close();
    results["B4"] = { statuses, retryAfter: refused?.headers["retry-after"] ?? null, body: refused?.body ?? null };
    expect(refused?.status).toBe(429);
    expect(Number(refused?.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(refused?.body ?? "{}")).toMatchObject({ ok: false, error: { code: "rate_limited", retryAfterMs: expect.any(Number) } });
    // Each accepted share reloads the embed: find the new player frames before the honest check.
    await a.page.waitForTimeout(3_000);
    [fa, fb] = [await ytFrame(a.page, BASELINE_ID), await ytFrame(b.page, BASELINE_ID)];
    await Promise.all([waitVideoPlaying(fa), waitVideoPlaying(fb)]);
    results["B4-honest"] = await honestSync();
  });

  test("B5 · spoofed X-Forwarded-For: 25 unauthorized shares, each with a new XFF, share one bucket (20 × 401, then 429)", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) {
      const r = await share("AAAAAAAAAAAAAAAAAAAAAA", embedUrl(BASELINE_ID), { origin: origin(), "x-forwarded-for": `203.0.113.${String(i + 1)}` });
      statuses.push(r.status);
    }
    results["B5"] = { statuses };
    expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
    expect(statuses.filter((s) => s === 429).length, "spoofed XFF didn't reset the bucket").toBeGreaterThan(0);
    results["B5-honest"] = await honestSync();
  });

  test("B6 · connection flood: the 6th member from one address gets too_many_members; an upgrade loop gets 429 + Retry-After, spoofed XFF too", async () => {
    // Join bucket: 6, one per 5 s. Let it refill after the joins above.
    await a.page.waitForTimeout(20_000);
    const page = await attacker.newPage();
    await page.goto(`${origin()}/healthz`);
    // honest-a and honest-b are 2 of this address's 5.
    const squat: string[][] = [];
    for (let i = 0; i < MEMBERS_PER_KEY - 1; i++) squat.push(types((await rawSocket(page, { join: `squat-${String(i)}`, keep: true, waitMs: 2_000 })).replies));
    await page.close();

    const statuses: number[] = [];
    let refused: Reply | null = null;
    // One at a time, closed at once, so only the rate trips (10, then one per 2 s), never the open-socket cap.
    for (let i = 0; i < 15 && refused === null; i++) {
      const u = await publicUpgrade();
      u.close();
      statuses.push(u.status);
      if (u.status === 429) refused = u;
    }
    const spoofed = await publicUpgrade({ "x-forwarded-for": "198.51.100.77" });
    spoofed.close();
    results["B6"] = { squat, upgrades: statuses, retryAfter: refused?.headers["retry-after"] ?? null, body: refused?.body ?? null, spoofedXff: spoofed.status };
    expect(squat.slice(0, MEMBERS_PER_KEY - 2).every((t) => t[0] === "snapshot")).toBe(true);
    expect(squat.at(-1)?.[0]).toBe("error:too_many_members");
    expect(refused?.status).toBe(429);
    expect(refused?.body).toBe("reconnecting too fast");
    expect(Number(refused?.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(spoofed.status).toBe(429);
    // The flood closes nothing the honest pair holds.
    await expect(a.page.locator(site.connectionStatus)).toHaveText("");
    results["B6-honest"] = await honestSync();
  });
});
