// Tunnel safety (OME-132, ADR 0015, docs/research/m2-tunnel-safety.md §7–8): the server runs in tunnel mode
// (PUBLIC_ORIGIN=https://omega.test, TRUST_PROXY=loopback, same-origin site) behind e2e/fixtures/proxy.ts, which
// behaves like ngrok. Each test names the ADR threat it covers. Serial: one server, one lobby, shared limits.
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { BrowserContext, Page } from "@playwright/test";
import { DEFAULT_ROOM_ID, SHARE_TOKEN_STORAGE_KEY, parseServerMessage, type RoomState } from "@omega/shared";
import { EXTENSION_DIR, EXTENSION_SHIPPED_DIR, ROOT, URLS } from "./support/apps";
import { VIDEO_ID, WATCH_URL } from "./support/network";
import { popup, site } from "./support/selectors";
import {
  EVIL_ORIGIN,
  PUBLIC_ORIGIN,
  SENTINEL_AUTHTOKEN,
  TUNNEL_BROWSER_ARGS,
  TUNNEL_PORTS,
  expect,
  passTunnelHosts,
  test,
  tunnelRequest,
  tunnelUpgrade,
} from "./tunnel-support";
import { chromium } from "@playwright/test";
import { watchCsp } from "./support/csp";

const ROOM = DEFAULT_ROOM_ID;
const ROOM_PATH = `/r/${ROOM}`;
const WS_PATH = `/rooms/${ROOM}/ws`;
const SHARE_PATH = `/rooms/${ROOM}/share`;
const PUBLIC_WS = `wss://omega.test${WS_PATH}`;
const TWITCH_CHANNEL_URL = "https://www.twitch.tv/omegatestchannel";
/** The site renders Twitch once its bundle loads the Embed SDK (OME-124/OME-125); until then this test is fixme. */
const TWITCH_SDK = "player.twitch.tv/js/embed/v1.js";
const siteLoadsTwitch = (siteDir: string): boolean =>
  walk(siteDir).some((f) => f.endsWith(".js") && readFileSync(f, "utf8").includes(TWITCH_SDK));

/** A distinct synthetic client per call, so tests never share a rate-limit bucket by accident. */
let nextClient = 1;
const freshClient = (): string => `203.0.113.${String(nextClient++)}`;

const share = (token: string | null, client: string, extra: Record<string, string> = {}, url: string = WATCH_URL) =>
  tunnelRequest({
    method: "POST",
    path: SHARE_PATH,
    headers: {
      "content-type": "application/json",
      "x-fixture-client": client,
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...extra,
    },
    body: JSON.stringify({ url }),
  });

/** Joins the lobby over a WebSocket opened by `page` (on omega.test) and returns the raw snapshot; the socket stays open. */
async function joinInPage(page: Page, nickname: string): Promise<{ token: string; room: RoomState }> {
  const raw = await page.evaluate(
    ({ url, nickname }) =>
      new Promise<string>((resolve, reject) => {
        const ws = new WebSocket(url);
        const kept = (window as unknown as { omegaSockets?: WebSocket[] }).omegaSockets ?? [];
        Object.assign(window, { omegaSockets: [...kept, ws] });
        ws.addEventListener("open", () => {
          ws.send(JSON.stringify({ type: "join", nickname, avatar: 0 }));
        });
        ws.addEventListener("message", (ev: MessageEvent<unknown>) => {
          if (typeof ev.data === "string" && ev.data.includes('"snapshot"')) resolve(ev.data);
        });
        ws.addEventListener("error", () => {
          reject(new Error("websocket error"));
        });
      }),
    { url: PUBLIC_WS, nickname },
  );
  const msg = parseServerMessage(raw);
  if (msg?.type !== "snapshot" || msg.shareToken === undefined) throw new Error("expected a snapshot with a share token");
  return { token: msg.shareToken, room: msg.room };
}

/** Opens `https://omega.test/r/lobby` in `context`, joins through the UI and waits for the room. */
async function enterRoom(context: BrowserContext, nickname: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${PUBLIC_ORIGIN}${ROOM_PATH}`);
  await page.locator(site.nicknameInput).fill(nickname);
  await page.locator(site.avatarOption).first().click();
  await page.locator(site.joinButton).click();
  await page.locator(site.room).waitFor();
  return page;
}

async function blankPage(context: BrowserContext, origin: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(origin === PUBLIC_ORIGIN ? `${PUBLIC_ORIGIN}/healthz` : `${origin}/`);
  return page;
}

test.describe.configure({ mode: "serial" });

test.describe("tunnel safety through the local reverse proxy", () => {
  // Starts the lane (site build, tunnel-mode server, proxy) once for the file.
  test.beforeAll(({ lane }) => {
    expect(lane.proxy.port).toBe(TUNNEL_PORTS.proxy);
  });

  test("T-06 DNS rebinding: a foreign Host gets 421 on HTTP and on the WebSocket upgrade", async () => {
    for (const host of ["rebind.test", `127.0.0.1:${String(TUNNEL_PORTS.proxy)}`, "omega.test.evil.test"]) {
      expect((await tunnelRequest({ path: "/rooms", host })).status, host).toBe(421);
      expect((await tunnelRequest({ path: ROOM_PATH, host })).status, host).toBe(421);
      const up = await tunnelUpgrade({ path: WS_PATH, host });
      up.close();
      expect(up.status, host).toBe(421);
    }
    // X-Forwarded-Host is never believed: ngrok passes a client's through (ADR 0015 §5).
    const xfh = { "x-forwarded-host": "omega.test" };
    expect((await tunnelRequest({ path: "/rooms", host: "rebind.test", headers: xfh })).status).toBe(421);
    const xfhUp = await tunnelUpgrade({ path: WS_PATH, host: "rebind.test", headers: xfh });
    xfhUp.close();
    expect(xfhUp.status).toBe(421);
    // The public host itself is fine.
    expect((await tunnelRequest({ path: "/rooms" })).status).toBe(200);
  });

  test("T-01 drive-by share without a (valid) token: 401 unauthorized", async () => {
    const client = freshClient();
    for (const token of [null, "not-a-token", "A".repeat(22)]) {
      const r = await share(token, client);
      expect(r.status, String(token)).toBe(401);
      expect(JSON.parse(r.body)).toMatchObject({ ok: false, error: { code: "unauthorized" } });
    }
  });

  test("T-04 hostile page: cross-origin share refused with 403, even with a stolen token; nothing changes", async ({ newTunnelContext }) => {
    const context = await newTunnelContext();
    const member = await blankPage(context, PUBLIC_ORIGIN);
    const { token, room: before } = await joinInPage(member, "victim");

    // A raw client presenting Origin: https://evil.test is refused before the token is looked at.
    const stolen = await share(token, freshClient(), { origin: EVIL_ORIGIN });
    expect(stolen.status).toBe(403);

    // From a real evil.test page: a simple (no-cors) POST and a CORS POST with a Bearer header.
    const evil = await blankPage(context, EVIL_ORIGIN);
    // The server answers 403 (asserted on the raw request above), and CORP stops the page from even reading that.
    const simple = evil.waitForEvent("requestfailed", (r) => r.url() === `${PUBLIC_ORIGIN}${SHARE_PATH}`);
    const outcome = await evil.evaluate(
      async ({ url, token, video }) => {
        // CORP same-origin (OME-188) makes the browser refuse the opaque response too, so this rejects.
        const simple = await fetch(url, { method: "POST", mode: "no-cors", headers: { "content-type": "text/plain" }, body: JSON.stringify({ url: video }) }).then(
          () => "read",
          () => "corp-blocked",
        );
        try {
          await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ url: video }) });
          return `${simple} cors-allowed`;
        } catch {
          return `${simple} cors-blocked`;
        }
      },
      { url: `${PUBLIC_ORIGIN}${SHARE_PATH}`, token, video: "https://www.youtube.com/watch?v=evilevil000" },
    );
    expect((await simple).failure()?.errorText).toBe("net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin");
    expect(outcome).toBe("corp-blocked cors-blocked");
    // The evil origin has no way to the token: it lives in omega.test's sessionStorage only.
    expect(await evil.evaluate((k) => sessionStorage.getItem(k), SHARE_TOKEN_STORAGE_KEY)).toBeNull();

    const { room: after } = await joinInPage(member, "observer");
    expect(after.embed).toEqual(before.embed);
  });

  test("T-05 cross-site WebSocket hijack: upgrade from a foreign Origin gets 403", async ({ newTunnelContext }) => {
    const refused = await tunnelUpgrade({ path: WS_PATH, headers: { origin: EVIL_ORIGIN } });
    refused.close();
    expect(refused.status).toBe(403);
    const ok = await tunnelUpgrade({ path: WS_PATH, headers: { origin: PUBLIC_ORIGIN } });
    ok.close();
    expect(ok.status).toBe(101);

    const evil = await blankPage(await newTunnelContext(), EVIL_ORIGIN);
    const result = await evil.evaluate(
      (url) =>
        new Promise<string>((resolve) => {
          const ws = new WebSocket(url);
          ws.addEventListener("open", () => {
            resolve("open");
          });
          ws.addEventListener("error", () => {
            resolve("error");
          });
        }),
      PUBLIC_WS,
    );
    expect(result).toBe("error");
  });

  test("T-09 one client can't lock everyone out: 10 sockets per client behind the proxy, the next client still joins", async () => {
    const hog = freshClient();
    const open = await Promise.all(Array.from({ length: 10 }, () => tunnelUpgrade({ path: WS_PATH, headers: { "x-fixture-client": hog } })));
    try {
      expect(open.map((u) => u.status)).toEqual(Array<number>(10).fill(101));
      const eleventh = await tunnelUpgrade({ path: WS_PATH, headers: { "x-fixture-client": hog } });
      eleventh.close();
      expect(eleventh.status).toBe(429);
      const other = await tunnelUpgrade({ path: WS_PATH, headers: { "x-fixture-client": freshClient() } });
      other.close();
      expect(other.status).toBe(101);
    } finally {
      for (const u of open) u.close();
    }
  });

  test("T-07 spoofed X-Forwarded-For doesn't dodge the cap: only the entry the tunnel appended counts", async () => {
    const client = freshClient();
    const spoof = (i: number) => ({ "x-fixture-client": client, "x-forwarded-for": `10.1.${String(i)}.1, 10.2.${String(i)}.2` });
    const open = await Promise.all(Array.from({ length: 10 }, (_, i) => tunnelUpgrade({ path: WS_PATH, headers: spoof(i) })));
    try {
      expect(open.map((u) => u.status)).toEqual(Array<number>(10).fill(101));
      const next = await tunnelUpgrade({ path: WS_PATH, headers: spoof(99) });
      next.close();
      expect(next.status).toBe(429);
    } finally {
      for (const u of open) u.close();
    }
  });

  test("T-12/T-13/T-16 site and WebSocket work over https/wss on the public origin; no mixed content, framing refused, token never in a URL", async ({ newTunnelContext, csp }) => {
    const urls: string[] = [];
    const sockets: string[] = [];
    const ctxA = await newTunnelContext();
    ctxA.on("request", (r) => urls.push(r.url()));
    ctxA.on("page", (p) => p.on("websocket", (ws) => sockets.push(ws.url())));
    const ada = await enterRoom(ctxA, "ada");
    const bo = await enterRoom(await newTunnelContext(), "bo");

    expect(sockets).toContain(PUBLIC_WS);
    expect(urls.filter((u) => u.startsWith("http:"))).toEqual([]);
    expect(await ada.evaluate(() => window.isSecureContext)).toBe(true);

    const record = await ada.evaluate((k) => sessionStorage.getItem(k), SHARE_TOKEN_STORAGE_KEY);
    expect(record).not.toBeNull();
    const { roomId, token } = readRecord(record);
    expect(roomId).toBe(ROOM);
    for (const u of [...urls, ...sockets, ada.url()]) expect(u).not.toContain(token);

    await ada.locator(site.chatInput).fill("hello through the tunnel");
    await ada.locator(site.chatInput).press("Enter");
    await expect(bo.locator(site.chatMessage).filter({ hasText: "hello through the tunnel" })).toBeVisible();

    const doc = await tunnelRequest({ path: ROOM_PATH });
    expect(doc.status).toBe(200);
    expect(String(doc.headers["content-security-policy"])).toContain("frame-ancestors 'none'");
    expect(doc.headers["x-content-type-options"]).toBe("nosniff");

    // Chromium refuses to render the framed document (net::ERR_BLOCKED_BY_RESPONSE).
    const evil = await blankPage(ctxA, EVIL_ORIGIN);
    const framed = `${PUBLIC_ORIGIN}${ROOM_PATH}`;
    const blocked = evil.waitForEvent("requestfailed", (r) => r.url() === framed && r.frame() !== evil.mainFrame());
    await evil.evaluate((src) => {
      const f = document.createElement("iframe");
      f.src = src;
      document.body.append(f);
    }, framed);
    expect((await blocked).failure()?.errorText).toContain("ERR_BLOCKED_BY_RESPONSE");
    await expect(evil.frameLocator("iframe").locator(site.nicknameInput)).toHaveCount(0);
    // Provoked on purpose, and console-only (no event fires in the embedder), so acknowledge it (OME-198).
    await expect.poll(() => csp.console.filter((t) => t.includes("frame-ancestors")).length).toBe(1);
    expect(csp.drainConsole(/frame-ancestors 'none'/)).toHaveLength(1);
  });

  test("Twitch parent is the public host", async ({ lane, newTunnelContext }) => {
    test.fixme(!siteLoadsTwitch(lane.siteDir), "the site bundle doesn't load the Twitch Embed SDK yet (OME-124/OME-125)");
    const page = await enterRoom(await newTunnelContext(), "twitch-watcher");
    const { token } = readRecord(await page.evaluate((k) => sessionStorage.getItem(k), SHARE_TOKEN_STORAGE_KEY));
    expect((await share(token, freshClient(), {}, TWITCH_CHANNEL_URL)).status).toBe(200);
    // The SDK builds `https://player.twitch.tv?…` (no slash before the query), so match the origin, then pin it.
    const frame = page.locator('iframe[src^="https://player.twitch.tv"]');
    await expect(frame).toHaveCount(1);
    const src = new URL((await frame.getAttribute("src")) ?? "");
    expect(src.origin).toBe("https://player.twitch.tv");
    expect(src.searchParams.getAll("parent")).toEqual(["omega.test"]);
  });

  test("extension shares through the public origin; popup reports an offline and an unreachable tunnel", async ({ lane }) => {
    test.setTimeout(60_000);
    // Playwright can't click Chrome's permission prompt, so load a copy of the e2e build that already holds the
    // grant Options would request (optional_host_permissions → https://omega.test/*). The grant flow itself is
    // unit-tested with a fake chrome.permissions (OME-130).
    const dir = mkdtempSync(join(tmpdir(), "omega-ext-tunnel-"));
    cpSync(EXTENSION_DIR, dir, { recursive: true });
    const manifestPath = join(dir, "manifest.json");
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (typeof manifest !== "object" || manifest === null) throw new Error("e2e manifest.json is not an object");
    const listed: unknown = "host_permissions" in manifest ? manifest.host_permissions : [];
    const granted: unknown[] = Array.isArray(listed) ? listed : [];
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, host_permissions: [...granted, `${PUBLIC_ORIGIN}/*`] }));

    const context = await watchCsp(await chromium.launchPersistentContext("", {
      channel: "chromium",
      ignoreHTTPSErrors: true,
      args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`, ...TUNNEL_BROWSER_ARGS],
    }));
    try {
      await passTunnelHosts(context);
      const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
      await sw.evaluate((url) => chrome.storage.local.set({ serverBaseUrl: url }), PUBLIC_ORIGIN);
      const extensionId = new URL(sw.url()).host;
      const openPopup = async (target: Page): Promise<Page> => {
        const url = target.url();
        const tabId = await sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, url);
        if (tabId === undefined) throw new Error(`no tab for ${url}`);
        const p = await context.newPage();
        await p.goto(`chrome-extension://${extensionId}/popup.html?tabId=${String(tabId)}`);
        return p;
      };

      const roomTab = await enterRoom(context, "ext-sharer");
      const source = await context.newPage();
      await source.goto(`${URLS.fixtures}/youtube-embed.html`);

      const p = await openPopup(source);
      await expect(p.locator(popup.embedItem)).toHaveCount(1);
      await expect(p.locator(popup.shareButton)).toBeEnabled();
      await expect(p.locator('[data-testid="server-status"]')).toBeHidden();
      await p.locator(popup.shareButton).click();
      await expect(p.locator(popup.shareStatus)).toHaveAttribute("data-state", "ok");

      const tv = roomTab.locator(`${site.sharedVideo} iframe, iframe${site.sharedVideo}`).first();
      await expect(tv).toHaveAttribute("src", new RegExp(`/embed/${VIDEO_ID}\\?`));
      // YouTube's `origin` is the public host, as Twitch's `parent` must be.
      expect(new URL((await tv.getAttribute("src")) ?? "").searchParams.get("origin")).toBe(PUBLIC_ORIGIN);
      await p.close();

      lane.proxy.setMode("offline");
      const offline = await openPopup(source);
      await expect(offline.locator('[data-testid="server-status"]')).toContainText("tunnel may be offline");
      await expect(offline.locator(popup.shareButton)).toBeDisabled();
      await offline.close();

      lane.proxy.setMode("down");
      const down = await openPopup(source);
      await expect(down.locator('[data-testid="server-status"]')).toContainText(`Can't reach ${PUBLIC_ORIGIN}`);
      await expect(down.locator(popup.shareButton)).toBeDisabled();
    } finally {
      lane.proxy.setMode("forward");
      await context.close();
    }
  });

  test("T-14 no authtoken in the repo, the build output or the logs", ({ lane }) => {
    // The server ran the whole suite with the sentinel in its environment; the site was built with it too.
    const log = lane.serverLog();
    expect(log).toContain("public origin https://omega.test");
    expect(log).not.toContain(SENTINEL_AUTHTOKEN);
    const real = process.env["NGROK_AUTHTOKEN"];
    const needles = [SENTINEL_AUTHTOKEN, ...(real === undefined || real === "" ? [] : [real])];

    // The wrapper script never prints it either.
    const dry = spawnSync("bash", ["scripts/tunnel.sh", PUBLIC_ORIGIN, "--dry-run"], {
      cwd: ROOT,
      env: { ...process.env, NGROK_AUTHTOKEN: SENTINEL_AUTHTOKEN },
      encoding: "utf8",
    });
    expect(dry.status).toBe(0);
    expect(`${dry.stdout}${dry.stderr}`).not.toContain(SENTINEL_AUTHTOKEN);

    // ngrok authtokens look like `<digit><25+ alnum>_<20+ alnum>`; nothing tracked or built may match, or contain a needle.
    const TOKEN_SHAPE = /\b\d[A-Za-z0-9]{25,}_[A-Za-z0-9]{20,}\b/;
    const tracked = spawnSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" }).stdout.split("\0").filter((f) => f !== "");
    const built = [lane.siteDir, EXTENSION_DIR, EXTENSION_SHIPPED_DIR].filter((d) => existsSync(d)).flatMap((d) => walk(d));
    expect(tracked.length).toBeGreaterThan(50);
    expect(built.length).toBeGreaterThan(5);
    const hits: string[] = [];
    for (const file of [...tracked.map((f) => join(ROOT, f)), ...built]) {
      if (!existsSync(file) || statSync(file).size > 5_000_000) continue;
      const text = readFileSync(file, "utf8");
      if (TOKEN_SHAPE.test(text) || needles.some((n) => text.includes(n))) hits.push(file);
      if (/NGROK_AUTHTOKEN\s*[=:]\s*["']?[A-Za-z0-9]{20,}/.test(text)) hits.push(`${file} (assignment)`);
    }
    // Never print the matches themselves: only the paths.
    expect(hits).toEqual([]);
  });

  // Last: it uses up the lobby's switches, and the worker-scoped server keeps that state for the tests after it.
  test("the room share limit holds behind the proxy, whoever shares and whatever XFF they send", async ({ newTunnelContext }) => {
    const page = await blankPage(await newTunnelContext(), PUBLIC_ORIGIN);
    const members = [await joinInPage(page, "sharer-a"), await joinInPage(page, "sharer-b"), await joinInPage(page, "sharer-c")];
    // The lobby takes 2 switches at once, then one per 10 s (OME-188), stricter than the per-client burst of 5
    // (covered across rooms by the server unit tests; the tunnel server has only the lobby). Earlier tests may
    // have used some, so every member shares from a fresh client with a spoofed XFF until the room refuses.
    let refused: Awaited<ReturnType<typeof share>> | null = null;
    for (const m of members) {
      const r = await share(m.token, freshClient(), { "x-forwarded-for": freshClient() });
      if (r.status === 429) {
        refused = r;
        break;
      }
      expect(r.status).toBe(200);
    }
    expect(refused?.status).toBe(429);
    expect(Number(refused?.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(refused?.body ?? "{}")).toMatchObject({ ok: false, error: { code: "rate_limited", retryAfterMs: expect.any(Number) } });
  });
});

/** The site's `sessionStorage["omega.share"]`: exactly `{ roomId, token }` with a 22-char base64url token (ADR 0015). */
function readRecord(raw: string | null): { roomId: string; token: string } {
  if (raw === null) throw new Error(`no ${SHARE_TOKEN_STORAGE_KEY} record`);
  const rec: unknown = JSON.parse(raw);
  if (typeof rec !== "object" || rec === null || Object.keys(rec).sort().join() !== "roomId,token") throw new Error(`bad record: ${String(raw.length)} chars`);
  const roomId = "roomId" in rec ? rec.roomId : null;
  const token = "token" in rec ? rec.token : null;
  if (typeof roomId !== "string" || typeof token !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(token)) throw new Error("bad record fields");
  return { roomId, token };
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}

declare const chrome: {
  tabs: { query(q: Record<string, never>): Promise<{ readonly id?: number; readonly url?: string }[]> };
  storage: { local: { set(items: Record<string, string>): Promise<void> } };
};
