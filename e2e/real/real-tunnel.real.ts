// Opt-in real-tunnel checks for the M2 sign-off (OME-133, docs/qa/m2-real-sign-off.md): a real public tunnel (ngrok, or
// the cloudflared fallback in docs/ops/tunnel.md) in front of a tunnel-mode server that the operator started. Skipped
// unless OMEGA_REAL_TUNNEL_ORIGIN is set. The local-proxy suite (e2e/tunnel*.e2e.ts, OME-132) proves the server logic;
// this proves a real tunnel keeps the assumptions it relies on (Host, Origin, X-Forwarded-For, https/wss, Twitch parent).
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect, test } from "@playwright/test";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { DEFAULT_ROOM_ID, SHARE_TOKEN_STORAGE_KEY } from "@omega/shared";
import { EXTENSION_DIR, URLS } from "../support/apps";
import { VIDEO_ID } from "../support/network";
import { popup, site } from "../support/selectors";
import { REAL, mediaSpread, providerFrame, twitchVodUrl, vimeoUrl, waitMediaPlaying } from "./providers";
import { closeAll, record, sampleVideo, shot, spreadOver, waitVideoPlaying, ytFrame } from "./real";
import type { Client } from "./real";

const ORIGIN = process.env["OMEGA_REAL_TUNNEL_ORIGIN"]?.replace(/\/$/, "");
/** The tunnel server's loopback port (not the dev server's): the Host check is tested there, as a rebinding page would. */
const LOCAL_PORT = Number(process.env["OMEGA_REAL_TUNNEL_PORT"] ?? "8787");
const ROOM_PATH = `/r/${DEFAULT_ROOM_ID}`;
const SHARE_PATH = `/rooms/${DEFAULT_ROOM_ID}/share`;
const FOREIGN = "https://example.com";
/** ngrok's free plan answers browser traffic with a warning page (the "interstitial"); cloudflared doesn't. */
const NGROK = ORIGIN !== undefined && /\.ngrok(-free)?\.(app|dev|io)$/.test(new URL(ORIGIN).hostname);
/** What the extension sends on every server request (apps/extension/src/settings.ts) so it never sees that page. */
const SKIP_WARNING: Record<string, string> = NGROK ? { "ngrok-skip-browser-warning": "1" } : {};
/**
 * A browser context past the interstitial, so the checks below test the server, not ngrok's warning page. Only requests
 * to the tunnel get the header: context-wide `extraHTTPHeaders` also reach the providers, and YouTube's player won't start.
 */
async function skipping(b: Browser): Promise<BrowserContext> {
  const context = await b.newContext();
  if (NGROK) await context.route(`${origin()}/**`, (route) => route.continue({ headers: { ...route.request().headers(), ...SKIP_WARNING } }));
  return context;
}

test.skip(ORIGIN === undefined, "set OMEGA_REAL_TUNNEL_ORIGIN to the public https origin of a running tunnel (docs/qa/m2-real-sign-off.md)");
test.describe.configure({ mode: "serial" });
test.setTimeout(240_000);

const origin = (): string => {
  if (ORIGIN === undefined) throw new Error("no tunnel origin");
  return ORIGIN;
};

/** Opens the room as a visitor would. If ngrok shows its interstitial, clicks *Visit Site* and says so. */
async function enterVia(context: BrowserContext, nickname: string): Promise<Client & { readonly interstitial: boolean }> {
  const page = await context.newPage();
  await page.goto(`${origin()}${ROOM_PATH}`);
  const visit = page.getByRole("button", { name: "Visit Site" });
  await page.locator(site.nicknameInput).or(visit).first().waitFor();
  const interstitial = await visit.isVisible();
  if (interstitial) {
    await shot(page, `m2-tunnel-interstitial-${nickname}`);
    await visit.click();
  }
  await page.locator(site.nicknameInput).fill(nickname);
  await page.locator(site.joinButton).click();
  await page.locator(site.room).waitFor();
  return { context, page, nickname, interstitial };
}

/** The member's share token as the site stores it (sessionStorage, ADR 0015). */
async function tokenOf(page: Page): Promise<string> {
  await expect.poll(() => page.evaluate((k) => sessionStorage.getItem(k), SHARE_TOKEN_STORAGE_KEY), { timeout: 10_000 }).not.toBeNull();
  const raw = await page.evaluate((k) => sessionStorage.getItem(k), SHARE_TOKEN_STORAGE_KEY);
  const rec: unknown = JSON.parse(raw ?? "null");
  if (typeof rec !== "object" || rec === null || !("token" in rec) || typeof rec.token !== "string") throw new Error("no share token record");
  return rec.token;
}

/** ngrok's local inspector (the agent's web UI API). The run owns the only ngrok session, so its log is ours. */
const NGROK_API = process.env["OMEGA_REAL_NGROK_API"] ?? "http://127.0.0.1:4040";

/** For each "METHOD /path": whether ngrok's latest such request carried `ngrok-skip-browser-warning`. */
async function ngrokSawHeader(wanted: readonly string[]): Promise<Record<string, boolean>> {
  const res: unknown = await (await fetch(`${NGROK_API}/api/requests/http?limit=100`)).json();
  const list: unknown = typeof res === "object" && res !== null && "requests" in res ? res.requests : [];
  const seen: Record<string, boolean> = {};
  const items: unknown[] = Array.isArray(list) ? list : [];
  for (const r of items) {
    const req: unknown = typeof r === "object" && r !== null && "request" in r ? r.request : null;
    if (typeof req !== "object" || req === null || !("method" in req) || !("uri" in req) || !("headers" in req)) continue;
    const key = `${String(req.method)} ${String(req.uri)}`;
    // Newest first: keep the first hit per key.
    if (!wanted.includes(key) || key in seen) continue;
    const headers = typeof req.headers === "object" && req.headers !== null ? Object.keys(req.headers) : [];
    seen[key] = headers.some((h) => h.toLowerCase() === "ngrok-skip-browser-warning");
  }
  return Object.fromEntries(wanted.map((k) => [k, seen[k] ?? false]));
}

/** A plain HTTP request to the loopback listener with any Host (Node's fetch won't send a custom Host). */
function local(path: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port: LOCAL_PORT, path, headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

test("tunnel-1 · the site, the API and the WebSocket over the public https origin, two browsers: chat and a YouTube spread", async () => {
  const one: Browser = await chromium.launch({ headless: false });
  const two: Browser = await chromium.launch({ headless: false });
  try {
    const health = await fetch(`${origin()}/healthz`, { headers: SKIP_WARNING });
    const a = await enterVia(await skipping(one), "tunnel-a");
    const b = await enterVia(await skipping(two), "tunnel-b");
    const wsUrls: string[] = [];
    b.page.on("websocket", (ws) => wsUrls.push(ws.url()));
    await a.page.locator(site.chatInput).fill("hello over the tunnel");
    await a.page.locator(site.chatInput).press("Enter");
    await expect(b.page.locator(site.chatMessage).filter({ hasText: "hello over the tunnel" })).toBeVisible({ timeout: 10_000 });
    const mixed = await a.page.evaluate(() => performance.getEntriesByType("resource").map((e) => e.name).filter((n) => n.startsWith("http:")));
    record("m2-tunnel-1", { origin: origin(), health: health.status, via: health.headers.get("server"), pageUrl: a.page.url(), chatDelivered: true, mixedContent: mixed });
    expect(health.status).toBe(200);
    expect(a.page.url().startsWith("https://")).toBe(true);
    expect(mixed).toEqual([]);
  } finally {
    await closeAll(one, two);
  }
});

test("tunnel-2 · the extension, configured with the tunnel URL, shares; a second browser watches in sync; Twitch plays with the tunnel host as parent", async ({ request }) => {
  // Playwright can't click Chrome's permission prompt, so load a copy of the e2e build already holding the grant
  // Options would request for this origin (as e2e/tunnel.e2e.ts does); the grant flow is unit-tested (OME-130).
  const dir = mkdtempSync(join(tmpdir(), "omega-ext-real-tunnel-"));
  cpSync(EXTENSION_DIR, dir, { recursive: true });
  const manifestPath = join(dir, "manifest.json");
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (typeof manifest !== "object" || manifest === null) throw new Error("e2e manifest.json is not an object");
  const listed: unknown = "host_permissions" in manifest ? manifest.host_permissions : [];
  const granted: unknown[] = Array.isArray(listed) ? listed : [];
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, host_permissions: [...granted, `${origin()}/*`] }));

  const ext = await chromium.launchPersistentContext("", { channel: "chromium", headless: false, args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`] });
  const other: Browser = await chromium.launch({ headless: false });
  try {
    const sw = ext.serviceWorkers()[0] ?? (await ext.waitForEvent("serviceworker"));
    await sw.evaluate((url) => chrome.storage.local.set({ serverBaseUrl: url }), origin());
    const extensionId = new URL(sw.url()).host;
    // No extra headers in the extension's browser: a first-time visitor, so on ngrok the interstitial shows once.
    const a = await enterVia(ext, "tunnel-ext");
    const b = await enterVia(await skipping(other), "tunnel-viewer");
    const source = await ext.newPage();
    await source.goto(`${URLS.fixtures}/youtube-embed.html`);
    const tabId = await sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, source.url());
    if (tabId === undefined) throw new Error("no source tab");
    const p = await ext.newPage();
    await p.goto(`chrome-extension://${extensionId}/popup.html?tabId=${String(tabId)}`);
    await expect(p.locator(popup.embedItem)).toHaveCount(1);
    await expect(p.locator('[data-testid="server-status"]')).toBeHidden();
    await p.locator(popup.shareButton).click();
    await expect(p.locator(popup.shareStatus)).toHaveAttribute("data-state", "ok");
    await p.close();
    // The popup's requests carry the cookie *Visit Site* set, so they'd pass anyway; ngrok's own request log shows they
    // also carry the header (tunnel-5 shows the header alone passes). Clearing the cookie instead breaks the room page:
    // its lazy chunks (youtube-*.js, twitch-*.js) then get the warning page.
    const popupHeader = NGROK ? await ngrokSawHeader(["GET /rooms", `POST ${SHARE_PATH}`]) : null;

    const [fa, fb] = [await ytFrame(a.page, VIDEO_ID), await ytFrame(b.page, VIDEO_ID)];
    await Promise.all([waitVideoPlaying(fa), waitVideoPlaying(fb)]);
    const ytOrigin = new URL(fa.url()).searchParams.get("origin");
    await a.page.waitForTimeout(3_000);
    const ytSteady = await spreadOver(fa, fb, 12, 500);
    await a.page.locator(site.playToggle).click();
    await b.page.waitForTimeout(2_000);
    const paused = await Promise.all([sampleVideo(fa), sampleVideo(fb)]);
    await a.page.locator(site.playToggle).click();
    await b.page.waitForTimeout(3_000);
    const ytAfterPlay = await spreadOver(fa, fb, 8, 250);
    await Promise.all([shot(a.page, "m2-tunnel-2-ext"), shot(b.page, "m2-tunnel-2-viewer")]);

    // Twitch refuses to play unless `parent` is the embedding host, which must be https off localhost.
    const token = await a.page.evaluate((k) => {
      const r: unknown = JSON.parse(sessionStorage.getItem(k) ?? "null");
      return typeof r === "object" && r !== null && "token" in r && typeof r.token === "string" ? r.token : "";
    }, SHARE_TOKEN_STORAGE_KEY);
    const tw = await request.post(`${origin()}${SHARE_PATH}`, { headers: { ...SKIP_WARNING, authorization: `Bearer ${token}`, origin: origin() }, data: { url: twitchVodUrl(REAL.twitchVod) } });
    const [ta, tb] = [await providerFrame(a.page, "twitch", `v${REAL.twitchVod}`), await providerFrame(b.page, "twitch", `v${REAL.twitchVod}`)];
    const parent = new URL(ta.url()).searchParams.getAll("parent");
    await Promise.all([waitMediaPlaying(a, ta), waitMediaPlaying(b, tb)]);
    await a.page.waitForTimeout(4_000);
    const twitchSteady = await mediaSpread(ta, tb, 12, 500);

    const result = {
      interstitialInExtBrowser: a.interstitial,
      popupHeader,
      ytOrigin,
      ytSteady,
      paused: paused.map((s) => (s === null ? null : { currentTime: s.currentTime, paused: s.paused, ad: s.ad, errorText: s.errorText })),
      bothPaused: paused.every((s) => s?.paused === true),
      pausedDiffMs: paused[0] && paused[1] ? Math.round((paused[0].currentTime - paused[1].currentTime) * 1000) : null,
      ytAfterPlay,
      twitchShare: tw.status(),
      twitchParent: parent,
      twitchSteady,
    };
    record("m2-tunnel-2", result);
    expect(a.interstitial).toBe(NGROK);
    if (popupHeader !== null) expect(Object.values(popupHeader), "the popup sends ngrok-skip-browser-warning").toEqual([true, true]);
    expect(ytOrigin).toBe(origin());
    expect(ytSteady.maxAbsMs).toBeLessThanOrEqual(500);
    expect(result.bothPaused).toBe(true);
    expect(ytAfterPlay.maxAbsMs).toBeLessThanOrEqual(500);
    expect(tw.status()).toBe(200);
    expect(parent).toEqual([new URL(origin()).hostname]);
    expect(twitchSteady.maxAbsMs).toBeLessThanOrEqual(500);
  } finally {
    await ext.close();
    await other.close();
  }
});

test("tunnel-3 · a foreign page is refused: cross-origin share 403 (even with a stolen token), cross-site WebSocket refused", async ({ browser, request }) => {
  const member = await enterVia(await skipping(browser), "tunnel-victim");
  // The foreign context skips the interstitial too, so on ngrok a refusal is the server's, not ngrok's page.
  const foreignCtx = await skipping(browser);
  try {
    const token = await tokenOf(member.page);
    // Tunnel-2 left the lobby on Twitch; the foreign attempts try Vimeo, so a Vimeo plate would mean one got through.
    const url = vimeoUrl(REAL.vimeo);
    const stolen = await request.post(`${origin()}${SHARE_PATH}`, { headers: { ...SKIP_WARNING, authorization: `Bearer ${token}`, origin: FOREIGN }, data: { url } });
    // From a real foreign page: the browser adds Origin itself.
    const foreign = await foreignCtx.newPage();
    await foreign.goto(FOREIGN);
    const fromPage = await foreign.evaluate(async ({ o, path, t, u }) => {
      const shareRes = await fetch(`${o}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${t}` }, body: JSON.stringify({ url: u }) })
        .then((r) => `status ${String(r.status)}`, (e: unknown) => `blocked: ${String(e)}`);
      const ws = await new Promise<string>((resolve) => {
        const s = new WebSocket(`${o.replace(/^https/, "wss")}/rooms/lobby/ws`);
        s.onopen = () => { resolve("open"); s.close(); };
        s.onerror = () => { resolve("error"); };
        setTimeout(() => { resolve("timeout"); }, 10_000);
      });
      return { shareRes, ws };
    }, { o: origin(), path: SHARE_PATH, t: token, u: url });
    // DNS rebinding: a foreign Host on the loopback listener. The tunnel routes by host, so only this path can try it.
    const hostEvil = await local("/healthz", "evil.example");
    const hostPublic = await local("/healthz", new URL(origin()).host);
    // None of that changed the room.
    await member.page.waitForTimeout(2_000);
    const plateAfterForeign = await member.page.locator('[data-testid="provider-plate"]').textContent().catch(() => null);
    // Control, by design (ADR 0007/0015): a token holder outside any browser (no Origin) may share; the token is the gate.
    const noOrigin = await request.post(`${origin()}${SHARE_PATH}`, { headers: { ...SKIP_WARNING, authorization: `Bearer ${token}` }, data: { url } });
    const result = { stolenTokenForeignOrigin: stolen.status(), fromForeignPage: fromPage, hostEvil, hostPublic, plateAfterForeign, tokenNoOriginControl: noOrigin.status() };
    record("m2-tunnel-3", result);
    expect(stolen.status()).toBe(403);
    // The page can't read a CORS-refused answer; either way nothing was shared (checked below).
    expect(fromPage.shareRes === "status 403" || fromPage.shareRes.startsWith("blocked")).toBe(true);
    expect(fromPage.ws).not.toBe("open");
    expect(hostEvil).toBe(421);
    expect(hostPublic).toBe(200);
    expect(plateAfterForeign ?? "", "nothing was shared from the foreign page").not.toContain("Vimeo");
    expect(noOrigin.status()).toBe(200);
  } finally {
    await closeAll(member.context, foreignCtx);
  }
});

test("tunnel-4 · the real tunnel's X-Forwarded-For can't be spoofed into fresh rate-limit buckets", async ({ request }) => {
  // Unauthorized share attempts have their own per-client bucket (burst 20, 1/s, docs/ops/tunnel.md). If the tunnel
  // appends the real client address, a new fake XFF entry per request doesn't help: the 21st+ gets 429.
  const statuses: number[] = [];
  for (let i = 0; i < 30; i++) {
    const r = await request.post(`${origin()}${SHARE_PATH}`, {
      headers: { ...SKIP_WARNING, origin: origin(), authorization: "Bearer AAAAAAAAAAAAAAAAAAAAAA", "x-forwarded-for": `198.51.100.${String(i + 1)}` },
      data: { url: twitchVodUrl(REAL.twitchVod) },
    });
    statuses.push(r.status());
  }
  record("m2-tunnel-4", { statuses, limited: statuses.filter((s) => s === 429).length });
  expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
  expect(statuses.filter((s) => s === 429).length, "spoofed XFF didn't reset the bucket").toBeGreaterThan(0);
});

test("tunnel-5 · ngrok only: a first-time browser visitor gets the interstitial, *Visit Site* reaches the room; the skip header bypasses it", async () => {
  test.skip(!NGROK, "ngrok-only check: cloudflared shows no interstitial");
  // Raw requests first, with a browser User-Agent: what ngrok answers with and without the extension's header.
  const ua = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
  const probe = async (headers: Record<string, string>): Promise<{ status: number; ngrokError: string | null; app: boolean }> => {
    const r = await fetch(`${origin()}${ROOM_PATH}`, { headers: { "user-agent": ua, accept: "text/html", ...headers } });
    const body = await r.text();
    return { status: r.status, ngrokError: r.headers.get("ngrok-error-code"), app: body.includes('<main id="app"') };
  };
  const raw = await probe({});
  const withHeader = await probe({ "ngrok-skip-browser-warning": "1" });
  const fresh: Browser = await chromium.launch({ headless: false });
  try {
    const a = await enterVia(await fresh.newContext(), "tunnel-fresh");
    // After *Visit Site* the room works as usual: the WebSocket is up (the member got a share token).
    const token = await tokenOf(a.page);
    const again = await a.page.goto(`${origin()}${ROOM_PATH}`);
    const secondVisitInterstitial = await a.page.getByRole("button", { name: "Visit Site" }).isVisible();
    await shot(a.page, "m2-tunnel-5-after-visit");
    const result = { raw, withHeader, firstVisitInterstitial: a.interstitial, joined: token.length > 0, secondVisitStatus: again?.status() ?? null, secondVisitInterstitial };
    record("m2-tunnel-5", result);
    expect(raw.ngrokError, "no header: the warning page").toBe("ERR_NGROK_6024");
    expect(raw.app).toBe(false);
    expect(withHeader.ngrokError).toBeNull();
    expect(withHeader.app).toBe(true);
    expect(a.interstitial).toBe(true);
    expect(secondVisitInterstitial, "shown once per browser").toBe(false);
  } finally {
    await fresh.close();
  }
});

declare const chrome: {
  tabs: { query(q: Record<string, never>): Promise<{ readonly id?: number; readonly url?: string }[]> };
  storage: { local: { set(items: Record<string, string>): Promise<void> } };
};
