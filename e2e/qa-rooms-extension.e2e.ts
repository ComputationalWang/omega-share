// QA rooms suite, extension side (OME-417, feature X1 / OME-412, ADR 0028, docs/research/m4-rooms-threat-model.md §3.5).
// The popup's room dropdown lists public rooms from `GET /rooms` plus the rooms open in site tabs (private ones too, from the
// tab's own URL), and never reads the site's localStorage["omega.rooms"] (owner tokens, invite keys).
// Rooms are created over HTTP, each request from its own loopback source address: the per-key creation bucket is 2 (ADR 0028 §1).
import { ROOM_SECRETS_STORAGE_KEY } from "@omega/shared";
import { request as httpRequest } from "node:http";
import type { BrowserContext, Locator, Page } from "@playwright/test";
import { PENDING, URLS, available } from "./support/apps";
import { expect, test } from "./support/extension";
import { gotoFixture } from "./support/network";
import { popup, site } from "./support/selectors";

test.fixme(!available.extension, PENDING.extension);
test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);

interface Reply {
  readonly status: number;
  readonly json: unknown;
}

const SERVER = new URL(URLS.server);
let sources = 0;

/** One JSON request to the server, with the site's Origin, sent from a source address no other request in this run has used. */
function call(method: "GET" | "POST" | "DELETE", path: string, opts: { readonly body?: unknown; readonly headers?: Record<string, string> } = {}): Promise<Reply> {
  const data = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  const n = sources++;
  const localAddress = `127.${String(100 + (Number(process.env["TEST_PARALLEL_INDEX"] ?? 0) % 100))}.${String(Math.floor(n / 250) % 250)}.${String(1 + (n % 250))}`;
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: SERVER.port,
        localAddress,
        method,
        path,
        headers: {
          origin: URLS.web,
          ...(data === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(data) }),
          ...opts.headers,
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (text += chunk));
        res.on("end", () => {
          let json: unknown = null;
          try {
            json = JSON.parse(text);
          } catch {
            // Not JSON: the status alone tells the test.
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("error", reject);
    req.end(data);
  });
}

interface CreatedRoom {
  readonly id: string;
  readonly ownerToken: string;
  readonly inviteKey: string | null;
}

function field(o: unknown, key: string): unknown {
  return typeof o === "object" && o !== null ? (Reflect.get(o, key) as unknown) : null;
}

function str(o: unknown, key: string): string | null {
  const value = field(o, key);
  return typeof value === "string" ? value : null;
}

/** `POST /rooms`, waiting out the server-wide creation bucket (10 at once, then 1 a minute) when other runs spent it. */
async function createRoom(title: string, visibility: "public" | "private"): Promise<CreatedRoom> {
  const deadline = Date.now() + 90_000;
  for (;;) {
    const res = await call("POST", "/rooms", { body: { title, visibility } });
    if (res.status === 429 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5_000));
      continue;
    }
    expect(res.status).toBe(201);
    const room = field(res.json, "room");
    const id = str(room, "id");
    const ownerToken = str(res.json, "ownerToken");
    if (id === null || ownerToken === null) throw new Error(`unexpected create reply: ${JSON.stringify(res.json)}`);
    return { id, ownerToken, inviteKey: str(res.json, "inviteKey") };
  }
}

async function listedRoomIds(): Promise<string[]> {
  const res = await call("GET", "/rooms");
  expect(res.status).toBe(200);
  const rooms = field(res.json, "rooms");
  return Array.isArray(rooms) ? rooms.flatMap((r: unknown) => str(r, "id") ?? []) : [];
}

/** Option values of the popup's room dropdown. */
const optionValues = (select: Locator): Promise<string[]> =>
  select.locator("option").evaluateAll((els) => els.map((e) => (e instanceof HTMLOptionElement ? e.value : "")));

/** Opens the popup and waits until its dropdown has loaded: that is once `waitFor` (a room that must be there) is listed. */
async function openSettledPopup(popupOf: () => Promise<Page>, waitFor: string): Promise<{ page: Page; select: Locator }> {
  const page = await popupOf();
  const select = page.locator(popup.roomSelect);
  await expect.poll(() => optionValues(select)).toContain(waitFor);
  return { page, select };
}

/** Opens the room's site page as a member (nickname, join): that puts a share token in the tab's sessionStorage. */
async function joinInTab(context: BrowserContext, url: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(url);
  await page.locator(site.nicknameInput).fill("qa-owner");
  await page.locator(site.joinButton).click();
  await expect(page.locator(site.room)).toBeVisible();
  return page;
}

test("a private room that is not open in a tab is neither in GET /rooms nor in the popup; a public one is in both", async ({ context, openPopup }) => {
  const stamp = Date.now().toString(36);
  const pub = await createRoom(`qa-pub-${stamp}`, "public");
  const priv = await createRoom(`qa-priv-${stamp}`, "private");
  expect(priv.inviteKey).not.toBeNull();

  const listed = await listedRoomIds();
  expect(listed).toContain(pub.id);
  expect(listed).not.toContain(priv.id);

  const target = await context.newPage();
  await gotoFixture(target, "youtube-embed");
  const { select } = await openSettledPopup(() => openPopup(target), pub.id);
  expect(await optionValues(select)).not.toContain(priv.id);
});

test("a private room open in a tab (invite link) is offered, and sharing into it from the popup lands in the room", async ({ context, openPopup }) => {
  const priv = await createRoom(`qa-priv-open-${Date.now().toString(36)}`, "private");
  const tab = await joinInTab(context, `${URLS.web}/r/${priv.id}#k=${priv.inviteKey ?? ""}`);
  // The site strips the key from the address bar.
  expect(tab.url()).toBe(`${URLS.web}/r/${priv.id}`);
  expect(await listedRoomIds()).not.toContain(priv.id);

  const target = await context.newPage();
  await gotoFixture(target, "youtube-embed");
  const { page: p, select } = await openSettledPopup(() => openPopup(target), priv.id);
  // X1 / threat model §3.5: tab rooms come first, and the one with a share token is pre-selected.
  expect((await optionValues(select))[0]).toBe(priv.id);
  await expect(select).toHaveValue(priv.id);
  // The label of an unlisted room is its id: the popup has no title for it.
  await expect(select.locator(`option[value="${priv.id}"]`)).toHaveText(priv.id);

  await expect(p.locator(popup.embedItem)).toHaveCount(1);
  await expect(p.locator(popup.shareButton)).toBeEnabled();
  await p.locator(popup.shareButton).click();
  await expect(p.locator(popup.shareStatus)).toHaveText(`Shared to ${priv.id}.`);
  await expect(p.locator(popup.shareStatus)).toHaveAttribute("data-state", "ok");
  await expect(tab.locator(site.sharedVideo)).toBeVisible();
});

test("the extension never reads localStorage omega.rooms: a stored private room that is not open is not offered, and no request carries its secrets", async ({ context, openPopup }) => {
  const stamp = Date.now().toString(36);
  const pub = await createRoom(`qa-pub-ls-${stamp}`, "public");
  const real = await createRoom(`qa-priv-ls-${stamp}`, "private");
  // A made-up room next to a real one whose owner token and invite key really work.
  const fake = { id: "qafakeprivateroomabcdefgh".padEnd(26, "a"), ownerToken: "FakeOwnerToken".padEnd(22, "o"), inviteKey: "FakeInviteKey".padEnd(22, "i") };
  expect([fake.id.length, fake.ownerToken.length, fake.inviteKey.length]).toEqual([26, 22, 22]);
  const secrets = [real.ownerToken, real.inviteKey ?? "", fake.ownerToken, fake.inviteKey];

  // The site's origin holds the secrets, as after creating rooms there.
  const record = JSON.stringify({
    v: 1,
    rooms: {
      [real.id]: { ownerToken: real.ownerToken, inviteKey: real.inviteKey ?? undefined },
      [fake.id]: { ownerToken: fake.ownerToken, inviteKey: fake.inviteKey },
    },
  });
  const seeder = await context.newPage();
  await seeder.goto(`${URLS.web}/`);
  await seeder.evaluate(([key, value]) => { if (key !== undefined && value !== undefined) localStorage.setItem(key, value); }, [ROOM_SECRETS_STORAGE_KEY, record]);
  expect(await seeder.evaluate((k) => localStorage.getItem(k), ROOM_SECRETS_STORAGE_KEY)).toContain(fake.ownerToken);
  await seeder.close();

  // Everything the browser sends from here on, from pages and from the extension's service worker alike.
  const seen: Promise<string>[] = [];
  context.on("request", (r) => {
    seen.push(
      r
        .allHeaders()
        .catch(() => r.headers())
        .then((h) => `${r.method()} ${r.url()} ${JSON.stringify(h)} ${r.postData() ?? ""}`),
    );
  });

  const target = await context.newPage();
  await gotoFixture(target, "youtube-embed");
  const { page: p, select } = await openSettledPopup(() => openPopup(target), pub.id);
  const options = await optionValues(select);
  expect(options).not.toContain(real.id);
  expect(options).not.toContain(fake.id);
  await expect(p.locator(popup.embedItem)).toHaveCount(1);

  const requests = await Promise.all(seen);
  expect(requests.some((r) => r.startsWith("GET ") && r.includes(`${URLS.server}/rooms `))).toBe(true);
  for (const secret of secrets) expect(requests.filter((r) => r.includes(secret))).toEqual([]);
  // Nor did anything ask the server about those rooms.
  expect(requests.filter((r) => r.includes(real.id) || r.includes(fake.id))).toEqual([]);
});

test("after the owner deletes the private room it is refused for sharing and leaves the dropdown once its tab is closed", async ({ context, openPopup }) => {
  const stamp = Date.now().toString(36);
  const priv = await createRoom(`qa-priv-del-${stamp}`, "private");
  const pub = await createRoom(`qa-pub-del-${stamp}`, "public");
  const tab = await joinInTab(context, `${URLS.web}/r/${priv.id}#k=${priv.inviteKey ?? ""}`);
  const target = await context.newPage();
  await gotoFixture(target, "youtube-embed");

  // A popup opened before the deletion: it holds the room's share token.
  const before = await openSettledPopup(() => openPopup(target), priv.id);
  await expect(before.select).toHaveValue(priv.id);
  await expect(before.page.locator(popup.shareButton)).toBeEnabled();

  const del = await call("DELETE", `/rooms/${priv.id}`, { headers: { authorization: `Bearer ${priv.ownerToken}` } });
  expect(del.status).toBe(200);

  await before.page.locator(popup.shareButton).click();
  await expect(before.page.locator(popup.shareStatus)).toHaveAttribute("data-state", "error");
  await expect(before.page.locator(popup.shareStatus)).not.toHaveText(/^Shared to/);
  await expect(tab.locator(site.sharedVideo)).toBeHidden();

  // A fresh popup while the room's tab is still open: the URL still names the room, and sharing is refused all the same.
  const during = await openSettledPopup(() => openPopup(target), pub.id);
  if ((await optionValues(during.select)).includes(priv.id)) {
    await during.select.selectOption(priv.id);
    if (await during.page.locator(popup.shareButton).isEnabled()) {
      await during.page.locator(popup.shareButton).click();
      await expect(during.page.locator(popup.shareStatus)).toHaveAttribute("data-state", "error");
    }
  }

  // With the tab closed, nothing names the room any more: absent on the next popup open.
  await tab.close();
  const after = await openSettledPopup(() => openPopup(target), pub.id);
  expect(await optionValues(after.select)).not.toContain(priv.id);
  expect(await listedRoomIds()).not.toContain(priv.id);
});
