// The chat log (OME-594, M7 W1, set k): a capped list under the stage, fed by the `chat` frames, the playback and policy
// lines, and the ADR 0030 notices. Bubbles stay. role=log (polite), reachable by keyboard with a visible focus, and the
// tone change's one-frame scrim is gone under prefers-reduced-motion. The cap and one-append rule are unit tests
// (apps/web/test/chat-log.test.ts); the frame budget with a chat burst is perf/chat.perf.ts.
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { ROOM_SECRETS_STORAGE_KEY } from "@omega/shared";
import { expect, test, watchCsp } from "./support/csp";
import { PENDING, URLS, available } from "./support/apps";
import { stubExternalNetwork } from "./support/network";
import { ownedRoom } from "./support/owned-rooms";
import { joinRoom, leaveAll, testRoom, type Client } from "./support/room";
import { site } from "./support/selectors";

test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);

let clients: Client[] = [];
let contexts: BrowserContext[] = [];
test.afterEach(async () => {
  await leaveAll(clients);
  await Promise.all(contexts.map((c) => c.close()));
  clients = [];
  contexts = [];
});

async function say(page: Page, text: string): Promise<void> {
  await page.locator(site.chatInput).fill(text);
  await page.locator(site.chatInput).press("Enter");
}

test("chat lands in everyone's log with the sender's name; mine is marked; the bubble still shows", async ({ browser }) => {
  clients = await joinRoom(browser, { roomUrl: testRoom("chat-log", "lines").url, count: 2, nicknamePrefix: "cl" });
  const [a, b] = clients;
  if (a === undefined || b === undefined) throw new Error("no clients");
  const log = (p: Page) => p.locator(site.chatLog);
  for (const c of clients) {
    await expect(log(c.page)).toBeVisible();
    await expect(log(c.page)).toHaveAttribute("role", "log");
    await expect(log(c.page)).toHaveAttribute("aria-live", "polite");
    await expect(log(c.page)).toHaveAccessibleName("Chat messages");
  }
  await say(a.page, "hello <b>there</b>");
  await say(b.page, "hi back");
  for (const c of clients) {
    await expect(c.page.locator(site.chatLogLine)).toHaveText(["cl-1 hello <b>there</b>", "cl-2 hi back"]);
    await expect(c.page.locator(`${site.chatLogLine} b`)).toHaveText(["cl-1", "cl-2"]);
  }
  await expect(a.page.locator(`${site.chatLogLine}.self`)).toHaveText(["cl-1 hello <b>there</b>"]);
  await expect(b.page.locator(`${site.chatLogLine}.self`)).toHaveText(["cl-2 hi back"]);
  await expect(a.page.locator(site.chatMessage)).toContainText(["hi back"]);
});

test("keyboard: Tab reaches the log and the message field, each with a visible focus ring", async ({ browser }) => {
  clients = await joinRoom(browser, { roomUrl: testRoom("chat-log", "keys").url, count: 1, nicknamePrefix: "ck" });
  const [a] = clients;
  if (a === undefined) throw new Error("no client");
  await say(a.page, "one");
  const focused = () => a.page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? null);
  const seen = new Set<string>();
  await a.page.locator(site.chatInput).focus();
  await a.page.keyboard.press("Shift+Tab");
  // Walk back from the field until the log has focus: it's before the chat row in the order.
  for (let i = 0; i < 6 && (await focused()) !== "chat-log"; i++) {
    seen.add((await focused()) ?? "");
    await a.page.keyboard.press("Shift+Tab");
  }
  expect(await focused()).toBe("chat-log");
  const ring = (sel: string) => a.page.locator(sel).evaluate((e) => getComputedStyle(e).outlineStyle);
  expect(await ring(site.chatLog)).not.toBe("none");
  await a.page.keyboard.press("Tab");
  for (let i = 0; i < 6 && (await focused()) !== "chat-input"; i++) await a.page.keyboard.press("Tab");
  expect(await focused()).toBe("chat-input");
  expect(await ring(site.chatInput)).not.toBe("none");
});

test("lines settle at 6 s; under reduced motion the turn has no scrim frame", async ({ browser }) => {
  clients = await joinRoom(browser, { roomUrl: testRoom("chat-log", "reduced").url, count: 1, nicknamePrefix: "cr" });
  const [a] = clients;
  if (a === undefined) throw new Error("no client");
  const line = a.page.locator(site.chatLogLine).first();
  const scrim = () => line.evaluate((e) => getComputedStyle(e, "::after").content);
  await say(a.page, "motion");
  await expect(line).not.toHaveClass(/is-settled/);
  await expect(line).toHaveClass(/is-settled/, { timeout: 8000 });
  await a.page.emulateMedia({ reducedMotion: "reduce" });
  expect(await scrim()).toBe("none");
  await a.page.emulateMedia({ reducedMotion: "no-preference" });
  expect(await scrim()).not.toBe("none");
});

async function ownerAndGuests(browser: Browser): Promise<{ owner: Page; guests: Page[] }> {
  const { id, ownerToken, inviteKey } = ownedRoom("chatmod");
  const open = async (secrets: string | null, nickname: string): Promise<Page> => {
    const context = await watchCsp(await browser.newContext());
    contexts.push(context);
    if (secrets !== null) {
      await context.addInitScript(
        ([origin, key, value]) => {
          if (location.origin === origin && localStorage.getItem(key ?? "") === null) localStorage.setItem(key ?? "", value ?? "");
        },
        [URLS.web, ROOM_SECRETS_STORAGE_KEY, secrets],
      );
    }
    await stubExternalNetwork(context);
    const page = await context.newPage();
    await page.goto(`${URLS.web}/r/${id}${secrets === null ? `#k=${inviteKey}` : ""}`);
    await page.locator(site.nicknameInput).fill(nickname);
    await page.locator(site.joinButton).click();
    await expect(page.locator(site.room)).toBeVisible();
    return page;
  };
  const owner = await open(JSON.stringify({ v: 1, rooms: { [id]: { ownerToken, inviteKey } } }), "host");
  const guests = [await open(null, "kit"), await open(null, "moss")];
  return { owner, guests };
}

test("ADR 0030 notices in the log: my mute (only me), and someone removed (everyone left)", async ({ browser }) => {
  const { owner, guests } = await ownerAndGuests(browser);
  const [kit, moss] = guests;
  if (kit === undefined || moss === undefined) throw new Error("no guests");
  const tag = (name: string) => owner.locator(site.nicknameTag).filter({ hasText: name });

  await tag("kit").click();
  await owner.locator(site.modMute).click();
  await expect(kit.locator(`${site.chatLogLine}:has(.ui-sysline.self)`)).toHaveText(["The host muted your chat. You can still watch and emote."]);
  await expect(moss.locator(site.chatLogLine).filter({ hasText: "muted" })).toHaveCount(0);

  await tag("moss").click();
  await owner.locator(`${site.modRemove} button`).click();
  await owner.locator(site.modConfirm).click();
  for (const p of [owner, kit]) await expect(p.locator(site.chatLogLine).filter({ hasText: "removed" })).toHaveText(["moss was removed by the host"]);
});
