// Owner moderation, end to end (OME-510, ADR 0030): the owner's menu and setting in the real site against the real
// server, with a guest and an observer so "everyone else" is a client of its own. Three owner powers:
//   kick: the kicked tab gets the notice, can't get back in during the cooldown (same tab; the server's per-address
//         cooldown needs a non-loopback client, so it's not reachable in this lane), and the others see the member go;
//   mute: the guest's chat stops reaching others and the guest's chat well says why; unmute restores it;
//   policy: under "Only me" a guest's play / pause / seek / share is refused while the owner's still reaches everyone;
//         "Everyone" gives the guest the remote back.
// Each test has a seeded owned room of its own (support/owned-rooms.ts), and the whole room joins before anything is moderated.
import type { APIRequestContext, Browser, BrowserContext, Page } from "@playwright/test";
import * as v from "valibot";
import { ROOM_SECRETS_STORAGE_KEY, parseServerMessage } from "@omega/shared";
import { expect, test, watchCsp } from "./support/csp";
import { PENDING, URLS, available } from "./support/apps";
import { EMBED_URL, stubExternalNetwork } from "./support/network";
import { ownedRoom, type OwnedRoom, type OwnedRoomName } from "./support/owned-rooms";
import { clickSettled } from "./support/room";
import { postShare } from "./support/share";
import { site } from "./support/selectors";
import { PAUSED, PLAYING, fakeState } from "../perf/sync";

test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);
test.setTimeout(90_000);

let contexts: BrowserContext[] = [];
test.afterEach(async () => {
  await Promise.all(contexts.map((c) => c.close()));
  contexts = [];
});

interface Member {
  readonly page: Page;
  /** `join` frames this page has sent. */
  readonly joins: () => number;
}

/** A new browser on the room's page: the owner's holds the room's secrets the way a creation stores them, a guest's has the invite link. */
async function open(browser: Browser, room: OwnedRoom, nickname: string, asOwner = false): Promise<Member> {
  const context = await watchCsp(await browser.newContext());
  contexts.push(context);
  if (asOwner) {
    const secrets = JSON.stringify({ v: 1, rooms: { [room.id]: { ownerToken: room.ownerToken, inviteKey: room.inviteKey } } });
    await context.addInitScript(
      ([origin, key, value]) => {
        if (location.origin === origin && localStorage.getItem(key ?? "") === null) localStorage.setItem(key ?? "", value ?? "");
      },
      [URLS.web, ROOM_SECRETS_STORAGE_KEY, secrets],
    );
  }
  await stubExternalNetwork(context);
  const page = await context.newPage();
  let joins = 0;
  page.on("websocket", (ws) => ws.on("framesent", (f) => {
    if (typeof f.payload === "string" && f.payload.includes('"type":"join"')) joins++;
  }));
  await page.goto(asOwner ? `${URLS.web}/r/${room.id}` : `${URLS.web}/r/${room.id}#k=${room.inviteKey}`);
  await page.locator(site.nicknameInput).fill(nickname);
  await page.locator(site.joinButton).click();
  return { page, joins: () => joins };
}

async function enter(browser: Browser, room: OwnedRoom, nickname: string, asOwner = false): Promise<Member> {
  const m = await open(browser, room, nickname, asOwner);
  await expect(m.page.locator(site.room)).toBeVisible();
  return m;
}

const tag = (page: Page, nickname: string) => page.locator(site.nicknameTag).filter({ hasText: nickname });

type Secret = { readonly inviteKey: string } | { readonly ownerToken: string };

/** Joins over a raw WebSocket (a private room needs the key or the owner token) for a share token. */
function joinRaw(roomId: string, nickname: string, secret: Secret): Promise<{ token: string; close: () => void }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${URLS.server.replace(/^http/, "ws")}/rooms/${roomId}/ws`);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("no snapshot with a share token within 10 s"));
    }, 10_000);
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "join", nickname, avatar: 0, ...secret }));
    });
    ws.addEventListener("message", (ev: MessageEvent<unknown>) => {
      if (typeof ev.data !== "string") return;
      const msg = parseServerMessage(ev.data);
      if (msg?.type === "error") {
        clearTimeout(timer);
        ws.close();
        reject(new Error(`join refused: ${msg.code}`));
      } else if (msg?.type === "snapshot" && msg.shareToken !== undefined) {
        clearTimeout(timer);
        resolve({ token: msg.shareToken, close: () => { ws.close(); } });
      }
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("websocket error"));
    });
  });
}

const ErrorReplySchema = v.object({ error: v.object({ code: v.string() }) });

/** One share of the test video as a member holding `secret`: the HTTP status and the refusal code, if any. */
async function shareAs(request: APIRequestContext, room: OwnedRoom, nickname: string, secret: Secret): Promise<{ status: number; code: string | null }> {
  const member = await joinRaw(room.id, nickname, secret);
  try {
    const res = await postShare(request, room.id, member.token, EMBED_URL);
    const body = v.safeParse(ErrorReplySchema, await res.json());
    return { status: res.status(), code: body.success ? body.output.error.code : null };
  } finally {
    member.close();
  }
}

async function openMenu(owner: Page, nickname: string): Promise<void> {
  await tag(owner, nickname).click();
  await expect(owner.locator(site.modMenu)).toContainText(nickname);
}

const room = (name: OwnedRoomName): OwnedRoom => ownedRoom(name);

test("owner kicks a guest: the kicked tab sees the notice and can't come back in the same tab during the cooldown, the others see the member go", async ({ browser }) => {
  const r = room("modkick");
  const owner = await enter(browser, r, "host", true);
  const kicked = await enter(browser, r, "kit");
  const observer = await enter(browser, r, "obs");
  for (const p of [owner.page, kicked.page, observer.page]) await expect(tag(p, "kit")).toHaveCount(1);

  await openMenu(owner.page, "kit");
  await owner.page.locator(`${site.modRemove} button`).click();
  await expect(owner.page.locator(site.modRemove)).toContainText("Remove kit for 10 min?");
  await owner.page.locator(site.modConfirm).click();

  // The kicked tab: the notice, with Rejoin waiting out the cooldown.
  const card = kicked.page.locator(site.roomKicked);
  await expect(card).toBeVisible();
  await expect(card).toContainText("You were removed from this room");
  await expect(kicked.page.locator(site.roomKickedRejoin)).toHaveAttribute("aria-disabled", "true");
  await expect(kicked.page.locator(site.roomKickedRejoin)).toContainText("Rejoin in");
  // The others: the avatar's name tag is gone; theirs and the owner's stay.
  for (const p of [owner.page, observer.page]) await expect(tag(p, "kit")).toHaveCount(0);
  await expect(tag(observer.page, "obs")).toHaveCount(1);
  await expect(tag(observer.page, "host")).toHaveCount(1);

  // Rejoin during the cooldown is a no-op, and a reload shows the notice without sending a join.
  await kicked.page.locator(site.roomKickedRejoin).click({ force: true });
  await expect(card).toBeVisible();
  const before = kicked.joins();
  await kicked.page.reload();
  await kicked.page.locator(site.nicknameInput).fill("kit");
  await kicked.page.locator(site.joinButton).click();
  await expect(kicked.page.locator(site.roomKicked)).toBeVisible();
  await kicked.page.waitForTimeout(500);
  expect(kicked.joins()).toBe(before);

  // The server's own cooldown (a new browser from the same address is closed with 4005 before any snapshot) isn't
  // reachable here: this server sees every browser as a loopback peer, which has no client key (ws.ts `keyed`), so
  // it records no cooldown. It needs TRUST_PROXY=loopback and a forwarded address, as in the tunnel lane's servers.

  // The owner can come back at once.
  const again = await enter(browser, r, "host2", true);
  await expect(tag(again.page, "obs")).toHaveCount(1);
});

test("owner mutes a guest: their chat stops reaching others and the guest's chat well says why; unmute restores it", async ({ browser }) => {
  const r = room("modmute");
  const owner = await enter(browser, r, "host", true);
  const guest = await enter(browser, r, "kit");
  const observer = await enter(browser, r, "obs");
  const said = (page: Page, text: string) => page.locator(site.chatMessage).filter({ hasText: text });
  const say = async (page: Page, text: string): Promise<void> => {
    await page.locator(site.chatInput).fill(text);
    await page.locator(site.chatInput).press("Enter");
  };

  // Before: the guest's chat reaches both.
  await say(guest.page, "before");
  for (const p of [owner.page, observer.page]) await expect(said(p, "before")).toHaveCount(1);

  await openMenu(owner.page, "kit");
  await expect(owner.page.locator(site.modMute)).toContainText("Mute chat");
  await owner.page.locator(site.modMute).click();

  // The guest: a read-only well saying the host muted them, and a line in the room log; the room stays.
  await expect(guest.page.locator(site.chatInput)).toHaveAttribute("placeholder", "The host muted your chat");
  await expect(guest.page.locator(site.chatInput)).toHaveJSProperty("readOnly", true);
  await expect(guest.page.locator(site.systemLine).last()).toContainText("muted your chat");
  await expect(guest.page.locator(site.room)).toBeVisible();
  // The owner's menu now offers to undo it.
  await openMenu(owner.page, "kit");
  await expect(owner.page.locator(site.modMute)).toContainText("Unmute chat");
  await owner.page.keyboard.press("Escape");

  // They try anyway: the keys go nowhere and nobody gets it. The observer's own chat still flows (the control).
  await guest.page.locator(site.chatInput).focus();
  await guest.page.keyboard.type("muted words");
  await guest.page.keyboard.press("Enter");
  await say(observer.page, "heard");
  await expect(said(owner.page, "heard")).toHaveCount(1);
  await expect(said(guest.page, "heard")).toHaveCount(1);
  for (const p of [owner.page, observer.page, guest.page]) await expect(said(p, "muted words")).toHaveCount(0);

  // Unmute: the well opens and the next message reaches everyone.
  await openMenu(owner.page, "kit");
  await owner.page.locator(site.modMute).click();
  await expect(guest.page.locator(site.chatInput)).toHaveJSProperty("readOnly", false);
  await expect(guest.page.locator(site.chatInput)).not.toHaveAttribute("placeholder", "The host muted your chat");
  await say(guest.page, "after");
  for (const p of [owner.page, observer.page]) await expect(said(p, "after")).toHaveCount(1);
  for (const p of [owner.page, observer.page, guest.page]) await expect(said(p, "muted words")).toHaveCount(0);
});

test("control policy owner-only: a guest's play, pause, seek and share are refused, the owner's reach everyone; Everyone gives it back", async ({ browser, request }) => {
  const r = room("modpolicy");
  const ownerSecret = { ownerToken: r.ownerToken };
  const guestSecret = { inviteKey: r.inviteKey };
  const owner = await enter(browser, r, "host", true);
  const guest = await enter(browser, r, "kit");
  const observer = await enter(browser, r, "obs");
  const all = [owner.page, guest.page, observer.page];
  const stateOf = (pages: readonly Page[]): Promise<(number | null)[]> => Promise.all(pages.map((p) => fakeState(p)));
  const everyone = async (state: number): Promise<void> => {
    await expect.poll(() => stateOf(all), { timeout: 10_000 }).toEqual(all.map(() => state));
  };
  const timeOf = (page: Page) => page.evaluate(() => window.__fakeYt?.player?.getCurrentTime() ?? null);

  // The owner shares a video; under the default policy (Everyone) the guest can pause it and the owner play it again.
  expect(await shareAs(request, r, "sharer", ownerSecret)).toEqual({ status: 200, code: null });
  await everyone(PLAYING);
  await expect(guest.page.locator(site.playToggle)).toHaveAttribute("aria-label", "Pause for everyone");
  await guest.page.locator(site.playToggle).click();
  await everyone(PAUSED);
  await owner.page.locator(site.playToggle).click();
  await everyone(PLAYING);

  // Owner-only: the guest's and the observer's keys are held; the owner's isn't.
  await clickSettled(owner.page, owner.page.locator(site.controlPolicyOption).filter({ hasText: "Only me" }));
  for (const p of [guest.page, observer.page]) {
    await expect(p.locator(site.playToggle)).toHaveAttribute("aria-disabled", "true");
    await expect(p.locator(site.playToggle)).toHaveAttribute("aria-label", "Only the host controls playback");
  }
  await expect(guest.page.locator(site.seek)).toBeDisabled();
  await expect(owner.page.locator(site.playToggle)).not.toHaveAttribute("aria-disabled", "true");

  // The guest presses the key anyway: nothing changes for anybody.
  await guest.page.locator(site.playToggle).click({ force: true });
  await guest.page.waitForTimeout(1000);
  expect(await stateOf(all)).toEqual([PLAYING, PLAYING, PLAYING]);
  // A guest's share is refused by the server with the code the ADR names, and the room keeps its video.
  expect(await shareAs(request, r, "guest-sharer", guestSecret)).toEqual({ status: 403, code: "control_owner_only" });
  expect(await stateOf(all)).toEqual([PLAYING, PLAYING, PLAYING]);

  // The owner's pause, play, seek and share still reach everyone.
  await owner.page.locator(site.playToggle).click();
  await everyone(PAUSED);
  await owner.page.locator(site.playToggle).click();
  await everyone(PLAYING);
  await owner.page.locator(site.seek).fill("120");
  for (const p of [guest.page, observer.page]) await expect.poll(() => timeOf(p), { timeout: 10_000 }).toBeGreaterThanOrEqual(119);
  expect((await shareAs(request, r, "owner-sharer", ownerSecret)).status).toBe(200);

  // Everyone again: the guest has the remote back.
  await clickSettled(owner.page, owner.page.locator(site.controlPolicyOption).filter({ hasText: "Everyone" }));
  await expect(guest.page.locator(site.playToggle)).not.toHaveAttribute("aria-disabled", "true");
  await expect(guest.page.locator(site.playToggle)).toHaveAttribute("aria-label", "Pause for everyone");
  await guest.page.locator(site.playToggle).click();
  await everyone(PAUSED);
  await guest.page.locator(site.playToggle).click();
  await everyone(PLAYING);
  expect((await shareAs(request, r, "guest-sharer-2", guestSecret)).status).toBe(200);
});
