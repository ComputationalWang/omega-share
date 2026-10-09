// Opt-in real-Twitch check for the invite key (OME-417; ADR 0028, docs/research/m4-rooms-threat-model.md §3.2, §3.4): `bun run e2e:real`.
// Real network, headed on Xvfb, never in CI. The real Twitch SDK sends `location.href` to Twitch as the player iframe's
// `referrer=`, so a private room's `#k=<key>` must be gone from the address before that script is even added.
// Evidence: e2e/real/results/invite-referrer.har and invite-referrer.json (the twitch URLs and what the page saw).
// The fake-SDK twin is e2e/qa-rooms.e2e.ts; this proves the same against the real script and player.
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOM_SECRETS_STORAGE_KEY, parseServerMessage } from "@omega/shared";
import * as v from "valibot";
import { expect, test, watchCsp } from "../support/csp";
import { URLS } from "../support/apps";
import { ownedRoom } from "../support/owned-rooms";
import { site } from "../support/selectors";
import { postShare } from "../support/share";
import { REAL, twitchVodUrl } from "./providers";
import { EVIDENCE_DIR, record, requireVirtualDisplay } from "./real";

test.beforeAll(requireVirtualDisplay);
test.setTimeout(120_000);

declare global {
  interface Window {
    /** location.href when each off-site script was added, and at DOMContentLoaded. */
    __qaRealHrefs?: { readonly what: string; readonly href: string }[];
  }
}

/** Raw WebSocket join with the invite key; the share token lasts while the socket is open. */
function joinWithKey(roomId: string, inviteKey: string): Promise<{ token: string; close: () => void }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${URLS.server.replace(/^http/, "ws")}/rooms/${roomId}/ws`);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("no snapshot within 10 s"));
    }, 10_000);
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "join", nickname: "qa-real-sharer", avatar: 0, inviteKey }));
    });
    ws.addEventListener("message", (ev: MessageEvent<unknown>) => {
      if (typeof ev.data !== "string") return;
      const msg = parseServerMessage(ev.data);
      if (msg?.type === "error") {
        clearTimeout(timer);
        ws.close();
        reject(new Error(`join refused: ${msg.code}`));
      } else if (msg?.type === "snapshot") {
        clearTimeout(timer);
        if (msg.shareToken === undefined) {
          ws.close();
          reject(new Error("snapshot carried no shareToken"));
        } else resolve({ token: msg.shareToken, close: () => { ws.close(); } });
      }
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("websocket error"));
    });
  });
}

const HarSchema = v.object({
  log: v.object({
    entries: v.array(
      v.looseObject({
        request: v.looseObject({ method: v.string(), url: v.string(), headers: v.array(v.object({ name: v.string(), value: v.string() })) }),
        response: v.looseObject({ status: v.number() }),
      }),
    ),
  }),
});

test("real Twitch: the invite key is gone before the SDK script is added and is in no request, including Twitch's own", async ({ browser, request }) => {
  const room = ownedRoom("real");
  const sharer = await joinWithKey(room.id, room.inviteKey);
  try {
    expect((await postShare(request, room.id, sharer.token, twitchVodUrl(REAL.twitchVod))).status()).toBe(200);
  } finally {
    sharer.close();
  }

  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const harPath = join(EVIDENCE_DIR, "invite-referrer.har");
  const context = await watchCsp(await browser.newContext({ recordHar: { path: harPath, content: "omit" } }));
  await context.addInitScript(() => {
    const seen: { what: string; href: string }[] = [];
    window.__qaRealHrefs = seen;
    document.addEventListener("DOMContentLoaded", () => seen.push({ what: "DOMContentLoaded", href: location.href }));
    new MutationObserver((records) => {
      for (const r of records)
        for (const n of r.addedNodes)
          if (n instanceof HTMLScriptElement && n.src !== "" && new URL(n.src).origin !== location.origin) seen.push({ what: `script added: ${n.src}`, href: location.href });
    }).observe(document, { childList: true, subtree: true });
  });
  const page = await context.newPage();
  await page.goto(`${URLS.web}/r/${room.id}#k=${room.inviteKey}`);
  expect(page.url()).toBe(`${URLS.web}/r/${room.id}`);
  await page.locator(site.nicknameInput).fill("qa-real-guest");
  await page.locator(site.joinButton).click();
  await expect(page.locator(site.room)).toBeVisible();
  await expect(page.locator(site.roomRefused)).toBeHidden();
  const iframe = page.locator('iframe[src^="https://player.twitch.tv"]');
  await expect(iframe).toBeAttached({ timeout: 30_000 });
  // Let Twitch's own player make its requests (config, GQL, usher, telemetry).
  await page.waitForTimeout(8_000);
  const iframeSrc = (await iframe.first().getAttribute("src")) ?? "";
  const hrefs = await page.evaluate(() => window.__qaRealHrefs ?? []);
  const stored = await page.evaluate((k) => localStorage.getItem(k) ?? "", ROOM_SECRETS_STORAGE_KEY);
  await context.close();

  // Page side: at every off-site script add, including the real SDK's, the address was the bare room path.
  expect(hrefs.some((h) => h.what.includes("player.twitch.tv/js/embed/v1.js"))).toBe(true);
  for (const h of hrefs) {
    expect(h.href, h.what).toBe(`${URLS.web}/r/${room.id}`);
  }
  expect(stored, "the key is kept in localStorage for the next visit").toContain(room.inviteKey);

  // HAR side.
  const entries = v.parse(HarSchema, JSON.parse(readFileSync(harPath, "utf8"))).log.entries;
  const twitchEntries = entries.filter((e) => new URL(e.request.url).hostname === "player.twitch.tv");
  const script = twitchEntries.filter((e) => new URL(e.request.url).pathname === "/js/embed/v1.js");
  const frames = twitchEntries.filter((e) => new URL(e.request.url).pathname === "/" && new URL(e.request.url).searchParams.has("referrer"));
  expect(script.length, "the real SDK script was requested").toBeGreaterThan(0);
  expect(frames.length, "the player iframe was requested").toBeGreaterThan(0);
  const referrers = frames.map((e) => new URL(e.request.url).searchParams.get("referrer"));
  for (const e of twitchEntries) {
    const u = new URL(e.request.url);
    expect(e.request.url).not.toContain(room.inviteKey);
    expect(u.hash).toBe("");
    for (const value of u.searchParams.values()) {
      expect(value).not.toContain(room.inviteKey);
      expect(value).not.toContain("#k=");
    }
  }
  for (const e of frames) {
    const u = new URL(e.request.url);
    expect(u.searchParams.getAll("parent").length, e.request.url).toBeGreaterThan(0);
    expect(u.searchParams.get("referrer"), e.request.url).toBe(`${URLS.web}/r/${room.id}`);
  }
  // Every entry, first and third party: no URL, header or post data carries the key (raw or percent-decoded) or a `#k=`.
  const text = JSON.stringify(entries);
  const decoded = decodeURIComponent(text.replace(/%(?![0-9a-f]{2})/gi, ""));
  const leaking = entries.filter((e) => JSON.stringify(e).includes(room.inviteKey)).map((e) => `${e.request.method} ${e.request.url}`);
  expect(leaking).toEqual([]);
  expect(decoded).not.toContain(room.inviteKey);
  expect(text).not.toContain("#k=");
  const hosts = [...new Set(entries.map((e) => new URL(e.request.url).hostname))].sort();
  expect(hosts.filter((h) => h.endsWith("twitch.tv") || h.endsWith("ttvnw.net") || h.endsWith("jtvnw.net")).length, "Twitch's own hosts were reached").toBeGreaterThan(1);

  const summary = {
    roomId: room.id,
    entries: entries.length,
    hosts,
    sdkScript: script.map((e) => ({ url: e.request.url, status: e.response.status, referer: e.request.headers.find((h) => h.name.toLowerCase() === "referer")?.value ?? null })),
    iframeSrc,
    iframeRequests: frames.map((e) => e.request.url),
    referrerValues: referrers,
    hrefsSeenByScriptAdds: hrefs,
  };
  record("invite-referrer", summary);
  writeFileSync(join(EVIDENCE_DIR, "invite-referrer.urls.txt"), `${twitchEntries.map((e) => e.request.url).join("\n")}\n`);
  await test.info().attach("invite-referrer.har", { path: harPath, contentType: "application/json" });
  await test.info().attach("invite-referrer.json", { body: JSON.stringify(summary, null, 2), contentType: "application/json" });
});
