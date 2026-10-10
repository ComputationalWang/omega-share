// QA rooms suite (OME-417, M5; ADR 0028, docs/research/m4-rooms-threat-model.md §2.3, §3.2, §3.4). Black-box checks of what
// a room's secrets do on the wire, recorded as HAR + WebSocket frame logs and attached to each test:
//  1. the invite key is out of the URL before the Twitch SDK runs, and in no HAR entry at all;
//  2. the owner token is in no URL, Referer, query, WS URL or received frame, and only in the owner's own `join` frame and
//     the `Authorization: Bearer` header of the one DELETE;
//  3. a delete closes a guest's socket with 4004 and the page shows the closed state, without reconnecting;
//  4. a private room is unlisted; without the key the room is refused and shows nobody; with the key it joins.
// The rooms are seeded (support/owned-rooms.ts: one per test, known secrets, no POST /rooms, whose limiters the other room
// specs share). Test 2 hands the owner's browser the site's own storage record, so the app uses the token as after a UI
// creation (rooms-web.e2e.ts covers that). A deleted room stays deleted: run with --retries=0, or a retry of tests 2 and 3 finds no room.
import { request as httpRequest } from "node:http";
import { ROOM_SECRETS_STORAGE_KEY, parseServerMessage } from "@omega/shared";
import type { Browser, BrowserContext, Page, TestInfo, WebSocket as PwWebSocket } from "@playwright/test";
import * as v from "valibot";
import { providerCase } from "../perf/providers";
import { expect, test, watchCsp } from "./support/csp";
import { PENDING, URLS, available } from "./support/apps";
import { stubExternalNetwork } from "./support/network";
import { ownedRoom } from "./support/owned-rooms";
import { site } from "./support/selectors";
import { postShare } from "./support/share";
import { cellCenter } from "../apps/web/src/layout";

test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);

let contexts: BrowserContext[] = [];
test.afterEach(async () => {
  await Promise.all(contexts.map((c) => c.close()));
  contexts = [];
});

declare global {
  interface Window {
    /** location.href when each off-site script was added, when the Twitch SDK ran (assigned window.Twitch), and at DOMContentLoaded. */
    __qaHrefs?: { readonly what: string; readonly href: string }[];
    /** Every WebSocket the page opened, with the close code once it closed. */
    __qaSockets?: { readonly url: string; code: number | null }[];
  }
}

// --- API helpers (a loopback source address per call, so no limiter is shared with another spec) ---

const SERVER = new URL(URLS.server);
// Random, not counted: a retry's fresh worker restarts any counter, and would reuse an address whose creation bucket is spent.
const octet = (): string => String(1 + Math.floor(Math.random() * 250));
const sourceAddress = (): string => `127.${octet()}.${octet()}.${octet()}`;

interface Reply {
  readonly status: number;
  readonly json: unknown;
}

function apiCall(method: "GET" | "DELETE", path: string, opts: { token?: string } = {}): Promise<Reply> {
  const data = "";
  const headers: Record<string, string | number> = {};
  if (opts.token !== undefined) headers["authorization"] = `Bearer ${opts.token}`;
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port: SERVER.port, localAddress: sourceAddress(), method, path, headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (text += chunk));
      res.on("end", () => {
        let json: unknown = null;
        try {
          json = JSON.parse(text);
        } catch {
          // not JSON: leave null
        }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on("error", reject);
    req.end(data);
  });
}

/** Joins over a raw WebSocket as `secret` says and resolves with the member's share token (from its own snapshot); the token lasts while the socket is open. */
function joinForShareToken(roomId: string, secret: { ownerToken?: string; inviteKey?: string }): Promise<{ token: string; close: () => void }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${URLS.server.replace(/^http/, "ws")}/rooms/${roomId}/ws`);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("no snapshot within 10 s"));
    }, 10_000);
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "join", nickname: "qa-sharer", avatar: 0, ...secret }));
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

// --- browser helpers ---

async function newContext(browser: Browser, harPath?: string): Promise<BrowserContext> {
  const context = await watchCsp(await browser.newContext(harPath === undefined ? {} : { recordHar: { path: harPath, content: "omit" } }));
  contexts.push(context);
  await stubExternalNetwork(context);
  // What an SDK would read from location.href: when a script is added, and when the Twitch SDK itself runs (it assigns window.Twitch).
  await context.addInitScript(() => {
    const seen: { what: string; href: string }[] = [];
    window.__qaHrefs = seen;
    document.addEventListener("DOMContentLoaded", () => seen.push({ what: "DOMContentLoaded", href: location.href }));
    new MutationObserver((records) => {
      for (const r of records)
        for (const n of r.addedNodes)
          if (n instanceof HTMLScriptElement && n.src !== "" && new URL(n.src).origin !== location.origin) seen.push({ what: `script added: ${n.src}`, href: location.href });
    }).observe(document, { childList: true, subtree: true });
    if (location.protocol === "http:" && location.port !== "") {
      let twitch: unknown;
      Object.defineProperty(window, "Twitch", {
        configurable: true,
        get: () => twitch,
        set: (value: unknown) => {
          seen.push({ what: "Twitch SDK executed", href: location.href });
          twitch = value;
        },
      });
    }
    // Close codes of every socket the page opens.
    const sockets: { url: string; code: number | null }[] = [];
    window.__qaSockets = sockets;
    const Native = window.WebSocket;
    class Spy extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        const entry = { url: String(url), code: null as number | null };
        sockets.push(entry);
        this.addEventListener("close", (ev) => {
          entry.code = ev.code;
        });
      }
    }
    window.WebSocket = Spy;
  });
  return context;
}

async function enter(page: Page, nickname: string): Promise<void> {
  await page.locator(site.nicknameInput).fill(nickname);
  await page.locator(site.joinButton).click();
}

interface FrameRecord {
  readonly who: string;
  readonly dir: "sent" | "received";
  readonly url: string;
  readonly payload: string;
}

/** Logs every frame of every WebSocket `page` opens. The log doubles as the WS URL list (`urls`). */
function logFrames(page: Page, who: string, log: FrameRecord[], urls: string[]): void {
  page.on("websocket", (ws: PwWebSocket) => {
    urls.push(ws.url());
    const rec = (dir: "sent" | "received") => (f: { payload: string | Buffer }) =>
      log.push({ who, dir, url: ws.url(), payload: typeof f.payload === "string" ? f.payload : f.payload.toString("base64") });
    ws.on("framesent", rec("sent"));
    ws.on("framereceived", rec("received"));
  });
}

const isRoomSocket = (url: string): boolean => /\/rooms\/[a-z0-9-]+\/ws/.test(url);

const HeaderSchema = v.object({ name: v.string(), value: v.string() });
const HarSchema = v.object({
  log: v.object({
    entries: v.array(
      v.looseObject({
        request: v.looseObject({ method: v.string(), url: v.string(), headers: v.array(HeaderSchema) }),
        response: v.looseObject({ status: v.number() }),
      }),
    ),
  }),
});
type HarEntry = v.InferOutput<typeof HarSchema>["log"]["entries"][number];

async function readHar(path: string): Promise<HarEntry[]> {
  const { readFile } = await import("node:fs/promises");
  return v.parse(HarSchema, JSON.parse(await readFile(path, "utf8"))).log.entries;
}

/** Closes the context (which writes its HAR), then parses it. */
async function closeAndRead(context: BrowserContext, path: string): Promise<HarEntry[]> {
  await context.close();
  return readHar(path);
}

/**
 * Entries that carry `secret` anywhere (URL, query, headers, post data, response headers), raw or percent-decoded.
 * `allowBearerOnDelete` forgives the one place the contract allows an owner token: `Authorization: Bearer` on a DELETE.
 */
function leaks(entries: readonly HarEntry[], secret: string, allowBearerOnDelete = false): string[] {
  const found: string[] = [];
  for (const e of entries) {
    const copy = allowBearerOnDelete && e.request.method === "DELETE" ? { ...e, request: { ...e.request, headers: e.request.headers.filter((h) => h.name.toLowerCase() !== "authorization") } } : e;
    const text = JSON.stringify(copy);
    if (text.includes(secret) || decodeURIComponent(text.replace(/%(?![0-9a-f]{2})/gi, "")).includes(secret)) found.push(`${e.request.method} ${e.request.url}`);
  }
  return found;
}

async function attachHar(info: TestInfo, name: string, path: string): Promise<void> {
  await info.attach(name, { path, contentType: "application/json" });
}

const attachFrames = async (info: TestInfo, name: string, log: readonly FrameRecord[]): Promise<void> =>
  info.attach(name, { body: JSON.stringify(log, null, 2), contentType: "application/json" });

/** Click floor cell (col, row) through the editor's hit layer (the stage is CSS-scaled from 960×600). */
async function clickCell(page: Page, col: number, row: number): Promise<void> {
  const hit = page.locator(site.editorHit);
  const box = await hit.boundingBox();
  if (box === null) throw new Error("editor hit layer not laid out");
  const p = cellCenter(col, row);
  const scale = box.width / 960;
  await hit.click({ position: { x: p.x * scale, y: p.y * scale } });
}

// --- tests ---

test("the invite key is gone before the Twitch SDK loads and appears in no recorded request", async ({ browser, request }, info) => {
  const room = ownedRoom("invite");
  // Share a Twitch VOD before anyone is in the room, so the guest's page mounts the Twitch SDK on joining.
  const sharer = await joinForShareToken(room.id, { ownerToken: room.ownerToken });
  try {
    expect((await postShare(request, room.id, sharer.token, providerCase("twitchVod").shareUrl)).status()).toBe(200);
  } finally {
    sharer.close();
  }

  const har = info.outputPath("invite-guest.har");
  const context = await newContext(browser, har);
  const page = await context.newPage();
  await page.goto(`${URLS.web}/r/${room.id}#k=${room.inviteKey}`);
  expect(page.url()).toBe(`${URLS.web}/r/${room.id}`);
  await enter(page, "qa-guest");
  await expect(page.locator(site.room)).toBeVisible();
  await expect(page.locator(site.roomRefused)).toBeHidden();
  await expect(page.locator('iframe[src^="https://player.twitch.tv"]')).toBeAttached();
  await expect.poll(() => page.evaluate(() => window.__qaHrefs?.some((h) => h.what === "Twitch SDK executed") ?? false)).toBe(true);

  // (c) At the moment the SDK ran, and at every earlier script add, the fragment was already gone.
  const hrefs = await page.evaluate(() => window.__qaHrefs ?? []);
  expect(hrefs.some((h) => h.what.includes("player.twitch.tv/js/embed/v1.js"))).toBe(true);
  for (const h of hrefs) {
    expect(h.href, h.what).not.toContain("#");
    expect(h.href, h.what).not.toContain(room.inviteKey);
  }
  const stillThere = await page.evaluate((k) => [location.href, localStorage.getItem(k) ?? ""], ROOM_SECRETS_STORAGE_KEY);
  expect(stillThere[0]).toBe(`${URLS.web}/r/${room.id}`);
  expect(stillThere[1], "the key is kept in localStorage for the next visit").toContain(room.inviteKey);

  const entries = await closeAndRead(context, har);
  await attachHar(info, "invite-guest.har", har);

  // (a) The SDK script and every player iframe: the `referrer` and `parent` the SDK built carry neither the key nor a fragment.
  const twitch = entries.filter((e) => new URL(e.request.url).hostname === "player.twitch.tv");
  const script = twitch.filter((e) => new URL(e.request.url).pathname === "/js/embed/v1.js");
  const frames = twitch.filter((e) => new URL(e.request.url).pathname === "/");
  expect(script.length, "the SDK script was requested").toBeGreaterThan(0);
  expect(frames.length, "a player iframe was requested").toBeGreaterThan(0);
  for (const e of twitch) {
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
    expect(u.searchParams.get("referrer"), e.request.url).toBe(`${URLS.web}/r/${room.id}`);
    expect(u.searchParams.getAll("parent").length, e.request.url).toBeGreaterThan(0);
  }
  // (b) No entry anywhere has it: URL, Referer, any header, post data, response.
  expect(leaks(entries, room.inviteKey)).toEqual([]);
  expect(leaks(entries, `#k=${room.inviteKey.slice(0, 4)}`)).toEqual([]);
});

test("the owner token is in no URL, Referer, query or broadcast; only the owner's join frame and the DELETE's Bearer header carry it", async ({ browser }, info) => {
  const ownerHar = info.outputPath("owner.har");
  const guestHar = info.outputPath("guest.har");
  const frames: FrameRecord[] = [];
  const wsUrls: string[] = [];
  const pageUrls: string[] = [];

  const ownerCtx = await newContext(browser, ownerHar);
  const owner = await ownerCtx.newPage();
  logFrames(owner, "owner", frames, wsUrls);
  owner.on("framenavigated", (f) => pageUrls.push(f.url()));
  const deletes: string[] = [];
  owner.on("request", (r) => {
    if (r.method() === "DELETE") deletes.push(r.url());
  });
  const { id: roomId, ownerToken, inviteKey } = ownedRoom("owner");
  // The site's own record, in the format room-secrets.ts writes after a creation: the owner token and the invite key.
  await ownerCtx.addInitScript(
    ([origin, key, value]) => {
      if (location.origin === origin && localStorage.getItem(key ?? "") === null) localStorage.setItem(key ?? "", value ?? "");
    },
    [URLS.web, ROOM_SECRETS_STORAGE_KEY, JSON.stringify({ v: 1, rooms: { [roomId]: { ownerToken, inviteKey } } })],
  );
  await owner.goto(`${URLS.web}/r/${roomId}`);
  pageUrls.push(owner.url());
  expect(owner.url()).toBe(`${URLS.web}/r/${roomId}`);
  await enter(owner, "qa-owner");
  await expect(owner.locator(site.room)).toBeVisible();
  const link = await owner.locator(site.inviteLink).inputValue();
  expect(link).toBe(`${URLS.web}/r/${roomId}#k=${inviteKey}`);

  const guestCtx = await newContext(browser, guestHar);
  const guest = await guestCtx.newPage();
  logFrames(guest, "guest", frames, wsUrls);
  await guest.goto(link);
  await enter(guest, "qa-guest");
  await expect(guest.locator(site.room)).toBeVisible();
  await expect(guest.locator(site.nicknameTag).filter({ hasText: "qa-owner" })).toBeVisible();
  expect(await guest.evaluate((k) => localStorage.getItem(k) ?? "", ROOM_SECRETS_STORAGE_KEY), "a guest's storage has no owner token").not.toContain(ownerToken);

  // Owner actions: open the editor and save a layout (the lamp from (9,0) to (8,1)), rename, then delete.
  await owner.locator(site.editRoom).click();
  await expect(owner.locator(site.editorTray)).toBeVisible();
  await clickCell(owner, 9, 0);
  await clickCell(owner, 8, 1);
  await expect(owner.locator(site.editorProblems)).toBeEmpty();
  await owner.locator(site.editorSave).click();
  await expect.poll(() => frames.some((f) => f.who === "guest" && f.dir === "received" && f.payload.includes('"layout-changed"'))).toBe(true);
  await owner.locator(site.editorTitle).fill("QA renamed");
  await owner.locator(site.editorRename).click();
  for (const p of [owner, guest]) await expect(p.locator(site.roomTitle)).toHaveText("QA renamed");
  const dom = await Promise.all([owner.content(), guest.content()]);
  for (const html of dom) expect(html).not.toContain(ownerToken);
  await owner.locator(site.editorDelete).click();
  await owner.locator(site.editorDeleteConfirm).click();
  for (const p of [owner, guest]) await expect(p.locator(site.roomClosed)).toBeVisible();
  pageUrls.push(owner.url(), guest.url());

  const ownerEntries = await closeAndRead(ownerCtx, ownerHar);
  const guestEntries = await closeAndRead(guestCtx, guestHar);
  await attachHar(info, "owner.har", ownerHar);
  await attachHar(info, "guest.har", guestHar);
  await attachFrames(info, "ws-frames.json", frames);
  await info.attach("ws-urls.json", { body: JSON.stringify(wsUrls, null, 2), contentType: "application/json" });

  // The recorded requests: the token only as Bearer on the owner's one DELETE of this room.
  expect(deletes, "the editor deleted over HTTP").toEqual([`${URLS.server}/rooms/${roomId}`]);
  const del = ownerEntries.filter((e) => e.request.method === "DELETE");
  expect(del.map((e) => e.request.url)).toEqual([`${URLS.server}/rooms/${roomId}`]);
  expect(del[0]?.response.status).toBe(200);
  expect(del[0]?.request.headers.find((h) => h.name.toLowerCase() === "authorization")?.value).toBe(`Bearer ${ownerToken}`);
  expect(leaks(ownerEntries, ownerToken, true)).toEqual([]);
  expect(leaks(guestEntries, ownerToken)).toEqual([]);
  // The guest's HAR is the invite key's too (the key never leaves the page except in the guest's own join frame).
  expect(leaks(guestEntries, inviteKey)).toEqual([]);
  expect(leaks(ownerEntries, inviteKey)).toEqual([]);
  // No Referer on any request carries a secret (also covered above), and no URL the pages visited or sockets opened does.
  for (const e of [...ownerEntries, ...guestEntries]) {
    const referer = e.request.headers.find((h) => h.name.toLowerCase() === "referer")?.value ?? "";
    expect(referer, e.request.url).not.toContain(ownerToken);
  }
  for (const u of [...pageUrls, ...wsUrls]) {
    expect(u).not.toContain(ownerToken);
    expect(u).not.toContain(inviteKey);
  }
  expect(wsUrls.some(isRoomSocket)).toBe(true);

  // The frames: the token only in the owner's own join, and in nothing anyone received.
  const room = frames.filter((f) => isRoomSocket(f.url));
  expect(room.some((f) => f.who === "guest" && f.dir === "received")).toBe(true);
  expect(room.filter((f) => f.dir === "received" && f.payload.includes(ownerToken))).toEqual([]);
  expect(room.filter((f) => f.who === "guest" && f.payload.includes(ownerToken))).toEqual([]);
  const withToken = room.filter((f) => f.payload.includes(ownerToken));
  expect(withToken.map((f) => `${f.who} ${f.dir}`)).toEqual(["owner sent"]);
  expect(v.parse(v.looseObject({ type: v.literal("join"), ownerToken: v.literal(ownerToken) }), JSON.parse(withToken[0]?.payload ?? "null"))).toBeTruthy();
  // The guest's join is where the invite key is allowed; nobody else receives it back.
  expect(room.filter((f) => f.dir === "received" && f.payload.includes(inviteKey))).toEqual([]);
});

test("deleting a room closes a guest's socket with 4004 and its page shows the closed state, without reconnecting", async ({ browser }, info) => {
  const room = ownedRoom("delete");
  const frames: FrameRecord[] = [];
  const context = await newContext(browser);
  const guest = await context.newPage();
  logFrames(guest, "guest", frames, []);
  await guest.goto(`${URLS.web}/r/${room.id}#k=${room.inviteKey}`);
  await enter(guest, "qa-guest");
  await expect(guest.locator(site.room)).toBeVisible();
  await expect.poll(() => frames.some((f) => f.dir === "received" && f.payload.includes('"snapshot"'))).toBe(true);

  const del = await apiCall("DELETE", `/rooms/${room.id}`, { token: room.ownerToken });
  expect(del.status).toBe(200);
  await expect(guest.locator(site.roomClosed)).toBeVisible();
  await expect(guest.locator(site.room)).toBeHidden();
  const roomSockets = (): Promise<{ url: string; code: number | null }[]> => guest.evaluate(() => (window.__qaSockets ?? []).filter((s) => /\/rooms\/[a-z0-9-]+\/ws/.test(s.url)));
  await expect.poll(async () => (await roomSockets()).map((s) => s.code)).toEqual([4004]);
  // Terminal: no new socket for a good while.
  await guest.waitForTimeout(3000);
  expect((await roomSockets()).map((s) => s.code)).toEqual([4004]);
  await attachFrames(info, "ws-frames.json", frames);
  // The room is gone for a new join too.
  await expect.poll(async () => (await apiCall("GET", "/rooms")).status).toBe(200);
  await expect(joinForShareToken(room.id, { ownerToken: room.ownerToken })).rejects.toThrow();
});

test("a private room is unlisted; without the key it is refused and shows nobody; with the key it joins", async ({ browser }, info) => {
  const room = ownedRoom("ux");
  const publicTitle = room.title;

  // Not in the list the API serves, nor on the home page.
  const list = v.parse(v.object({ rooms: v.array(v.looseObject({ id: v.string() })) }), (await apiCall("GET", "/rooms")).json);
  expect(list.rooms.length).toBeGreaterThan(0);
  expect(list.rooms.map((r) => r.id)).not.toContain(room.id);
  const homeCtx = await newContext(browser);
  const home = await homeCtx.newPage();
  await home.goto(`${URLS.web}/`);
  await expect(home.locator(site.publicRoomLink).first()).toBeVisible();
  const hrefs = await home.locator(site.publicRoomLink).evaluateAll((as) => as.map((a) => a.getAttribute("href") ?? ""));
  expect(hrefs.length).toBeGreaterThan(0);
  expect(hrefs.join(" ")).not.toContain(room.id);
  const html = await home.content();
  expect(html).not.toContain(room.id);
  expect(html).not.toContain(publicTitle);

  // Without the key: refused, no room view, no member list, no snapshot ever received.
  const frames: FrameRecord[] = [];
  const strangerCtx = await newContext(browser);
  const stranger = await strangerCtx.newPage();
  logFrames(stranger, "stranger", frames, []);
  await stranger.goto(`${URLS.web}/r/${room.id}`);
  await enter(stranger, "qa-stranger");
  // OME-768: the same "Room not found" as an unknown id, so the page never tells a private room from no room.
  await expect(stranger.locator(site.notFound)).toBeVisible();
  await expect(stranger.locator(site.roomRefused)).toBeHidden();
  await expect(stranger.locator(site.room)).toBeHidden();
  await expect(stranger.locator(site.nicknameTag)).toHaveCount(0);
  await expect(stranger.locator(site.sharedVideo)).toHaveCount(0);
  const received = frames.filter((f) => f.dir === "received" && isRoomSocket(f.url)).map((f) => f.payload);
  expect(received.some((p) => /"type":"(snapshot|member-joined)"/.test(p))).toBe(false);
  expect(received.join(" ")).not.toContain("qa-stranger");

  // A well-formed but wrong key is no better.
  const wrongCtx = await newContext(browser);
  const wrong = await wrongCtx.newPage();
  await wrong.goto(`${URLS.web}/r/${room.id}#k=${"A".repeat(22)}`);
  expect(wrong.url()).toBe(`${URLS.web}/r/${room.id}`);
  await enter(wrong, "qa-wrong");
  await expect(wrong.locator(site.notFound)).toBeVisible();
  await expect(wrong.locator(site.room)).toBeHidden();

  // With the key: in.
  const guestCtx = await newContext(browser);
  const guest = await guestCtx.newPage();
  await guest.goto(`${URLS.web}/r/${room.id}#k=${room.inviteKey}`);
  await enter(guest, "qa-invited");
  await expect(guest.locator(site.room)).toBeVisible();
  await expect(guest.locator(site.roomRefused)).toBeHidden();
  await expect(guest.locator(site.nicknameTag).filter({ hasText: "qa-invited" })).toBeVisible();
  // A second visit from the same browser needs no fragment: the key was kept.
  await guest.goto(`${URLS.web}/r/${room.id}`);
  await enter(guest, "qa-invited");
  await expect(guest.locator(site.room)).toBeVisible();
  await info.attach("private-room.json", { body: JSON.stringify({ roomId: room.id, strangerFrames: frames }, null, 2), contentType: "application/json" });
});
