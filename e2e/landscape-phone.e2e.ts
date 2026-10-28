// A phone held sideways (OME-1297): 601–1023 px wide and short. The room page uses the wide two-column layout with a
// narrower chat column, so the picture fits the height and the shelf, Up next and the chat field are in view without
// scrolling the page; the chat column follows the visual viewport while the keyboard is up, and the notch stays clear.
// The rotation round trip (portrait dock back, playback, seat and draft kept) is in m10-portrait.e2e.ts.
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./support/csp";
import { PENDING, available } from "./support/apps";
import { joinRoom, leaveAll, testRoom, type Client, type JoinOptions } from "./support/room";
import { site } from "./support/selectors";
import { URLS } from "./support/apps";
import AxeBuilder from "@axe-core/playwright";
import { providerCase, shareProvider } from "../perf/providers";
import { FAKE_VIMEO_SDK } from "./support/network";
import { ROOM_SECRETS_STORAGE_KEY } from "@omega/shared";
import { ownedRoom } from "./support/owned-rooms";

test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);

let clients: Client[] = [];
test.afterEach(async () => {
  await leaveAll(clients);
  clients = [];
});

async function box(l: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = await l.boundingBox();
  if (b === null) throw new Error("not laid out");
  return b;
}

/** Wholly inside [left, right] × [top, bottom] of the layout viewport. */
async function inside(l: Locator, top: number, bottom: number, left = 0, right = Infinity): Promise<void> {
  await expect(l).toBeVisible();
  const b = await box(l);
  expect(b.y).toBeGreaterThanOrEqual(top);
  expect(b.y + b.height).toBeLessThanOrEqual(bottom);
  expect(b.x).toBeGreaterThanOrEqual(left);
  expect(b.x + b.width).toBeLessThanOrEqual(right);
  // A box can sit in the viewport yet be clipped by a scrolling ancestor (QA OME-1305): the finger must land on it.
  expect(await l.evaluate((node) => {
    const r = node.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return hit !== null && (hit === node || node.contains(hit)) ? "reachable" : hit?.outerHTML.slice(0, 80) ?? "nothing";
  }), String(l)).toBe("reachable");
}

async function open(browser: Parameters<typeof joinRoom>[0], name: "l932" | "l844" | "l667" | "f844" | "f740" | "w844" | "p844" | "q932" | "q844" | "q667" | "notch" | "twitch" | "tvshelf" | "tliveshelf" | "vshelf" | "vhourshelf" | "v844", width: number, height: number, setup: NonNullable<JoinOptions["setup"]> = () => Promise.resolve()): Promise<Page> {
  clients = await joinRoom(browser, { roomUrl: testRoom("landscape-phone", name).url, count: 1, nicknamePrefix: `land${name}${String(test.info().retry)}${String(test.info().repeatEachIndex)}`, setup,
    contextOptions: () => ({ viewport: { width, height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }) });
  const page = clients[0]?.page;
  if (page === undefined) throw new Error("no client");
  await expect(page.locator(site.chatInput)).toBeVisible();
  return page;
}

for (const [name, width, height] of [["l932", 932, 430], ["l844", 844, 390], ["l667", 667, 375]] as const) {
  test(`${String(width)}×${String(height)} landscape: picture, shelf, Up next and chat fit unscrolled; the field stays above the keyboard`, async ({ browser }) => {
    const page = await open(browser, name, width, height);
    await expect(page.locator("#room-root")).not.toHaveClass(/room-portrait/);
    const input = page.locator(site.chatInput);
    for (const l of [site.tv, site.playToggle, site.queueUrl, site.chatInput]) await inside(page.locator(l), 0, height, 0, width);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    expect(await page.evaluate(() => document.scrollingElement?.scrollHeight ?? 0)).toBeLessThanOrEqual(height);
    expect(await page.evaluate(() => document.scrollingElement?.scrollWidth ?? 0)).toBeLessThanOrEqual(width);
    // The picture keeps its ADR 0012 minimum; the field keeps its room.
    expect((await box(page.locator(site.tv))).width).toBeGreaterThanOrEqual(356);
    expect((await box(input)).width).toBeGreaterThanOrEqual(120);
    expect((await box(page.locator(site.queueUrl))).width).toBeGreaterThanOrEqual(120);

    await input.fill("sideways hello");
    await input.press("Enter");
    await expect(page.locator(site.chatLogLine).last()).toContainText("sideways hello");

    // The OS keyboard is outside browser automation: simulate its visualViewport (iOS keeps the layout viewport).
    await input.focus();
    const kb = { top: 24, height: height - 220 };
    await page.evaluate(({ top, height: h }) => {
      const v = new EventTarget();
      Object.assign(v, { height: h, width: innerWidth, offsetTop: top, offsetLeft: 0, scale: 1 });
      Object.defineProperty(window, "visualViewport", { configurable: true, value: v });
      window.dispatchEvent(new Event("resize"));
    }, kb);
    await expect(input).toBeFocused();
    await expect.poll(async () => { const b = await box(input); return b.y + b.height; }).toBeLessThanOrEqual(kb.top + kb.height);
    await inside(input, kb.top, kb.top + kb.height);
    // The keyboard goes: the column is full height again.
    await page.evaluate(() => {
      const v = window.visualViewport;
      if (v === null) throw new Error("no visual viewport");
      Object.assign(v, { height: innerHeight, offsetTop: 0 });
      window.dispatchEvent(new Event("resize"));
    });
    await expect.poll(async () => { const b = await box(input); return b.y + b.height; }).toBeGreaterThan(kb.top + kb.height);
    await inside(input, 0, height);
  });
}

test("844×390 landscape with a notch: the room and the chat column keep clear of the side insets", async ({ browser }) => {
  const page = await open(browser, "notch", 844, 390);
  const cdp = await page.context().newCDPSession(page);
  const inset = 47;
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { left: inset, right: inset } });
  for (const l of [site.tv, site.playToggle, site.queueUrl, site.chatInput, site.chatLog]) {
    await expect.poll(async () => (await box(page.locator(l))).x).toBeGreaterThanOrEqual(inset);
    await inside(page.locator(l), 0, 390, inset, 844 - inset);
  }
});

// QA OME-1594 → OME-1595: the picture and its shelf filled the column and the floor was a ~20 px strip under them,
// reachable only by finding the column's scroll; the fields showed their placeholder's first word.
for (const [name, width, height] of [["f844", 844, 390], ["f740", 740, 360]] as const) {
  test(`${String(width)}×${String(height)} landscape: a seat a finger can take is on screen unscrolled; the chat and link fields show 15 characters`, async ({ browser }) => {
    const page = await open(browser, name, width, height);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    expect(await page.locator("#room-root").evaluate((n) => n.scrollTop)).toBe(0);
    const seats = page.locator(`${site.seat}:not([inert])`);
    await expect.poll(() => seats.count()).toBeGreaterThanOrEqual(1);
    await inside(seats.first(), 0, height, 0, width);
    for (const l of [site.chatInput, site.queueUrl]) {
      const field = page.locator(l);
      await field.fill("abcdefghijklmno");
      expect(await field.evaluate((n) => n.scrollWidth <= n.clientWidth), l).toBe(true);
      await field.fill("");
    }
  });
}

/** Three raw members each queue QUEUE_ADD_MEMBER_BURST (3) links: one plays, eight wait in Up next. */
async function fillQueue(roomId: string, tag: string): Promise<() => void> {
  const sockets = await Promise.all([0, 1, 2].map((m) => new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(`${URLS.server.replace(/^http/, "ws")}/rooms/${roomId}/ws`);
    ws.addEventListener("open", () => { ws.send(JSON.stringify({ type: "join", nickname: `${tag}q${String(m)}r${String(test.info().retry)}${String(test.info().repeatEachIndex)}`, avatar: 0 })); });
    let sent = false;
    ws.addEventListener("message", (ev: MessageEvent<unknown>) => {
      if (sent || typeof ev.data !== "string" || !ev.data.includes('"snapshot"')) return;
      sent = true;
      // An 11-character video id: the room name (4), the member, the link, padding.
      for (let i = 0; i < 3; i++) ws.send(JSON.stringify({ type: "queue-add", url: `https://youtu.be/${tag}${String(m)}${String(i)}aaaaa` }));
      resolve(ws);
    });
    ws.addEventListener("error", () => { reject(new Error("websocket error")); });
  })));
  return () => { for (const ws of sockets) ws.close(); };
}

for (const [name, width, height] of [["q932", 932, 430], ["q844", 844, 390], ["q667", 667, 375]] as const) {
  test(`${String(width)}×${String(height)} landscape, a full Up next: its list scrolls to its last row, the chat log keeps three lines, the field keeps its row`, async ({ browser }) => {
    const page = await open(browser, name, width, height);
    const close = await fillQueue(testRoom("landscape-phone", name).id, name);
    try {
      const rows = page.locator(site.queueRow);
      // At least: a retry reuses the room and its queue.
      await expect.poll(() => rows.count()).toBeGreaterThanOrEqual(8);
      // The title stays readable in the narrow column (OME-1313): the chip keeps only its glyph (~34 px; the word made it ~60),
      // its word stays for a screen reader.
      const first = rows.first();
      expect((await box(first.locator(".title"))).width).toBeGreaterThanOrEqual(80);
      expect((await box(first.locator(".ui-chip"))).width).toBeLessThanOrEqual(40);
      await expect(first.locator(".ui-chip")).toHaveText(/synced/i);
      // At 667×375 about half a row shows (CI's fonts give 23 px); the list scrolls to the rest, checked below.
      const list = page.locator(`${site.queuePanel} .ui-qlist`);
      expect(await list.evaluate((n) => n.clientHeight)).toBeGreaterThanOrEqual(20);
      for (const l of [site.tv, site.playToggle, site.queueCount, site.queueUrl, site.queueAdd, site.chatInput]) await inside(page.locator(l), 0, height, 0, width);
      expect((await box(page.locator(site.chatLog))).height).toBeGreaterThanOrEqual(60);
      // Rows redraw while the adds land: retry the scroll until the last one holds still.
      await expect(async () => {
        const last = rows.last();
        await last.scrollIntoViewIfNeeded({ timeout: 1_000 });
        await inside(last, 0, height, 0, width);
      }).toPass({ timeout: 10_000 });
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
      // The keyboard up while typing a link: the link field and Add stay above it.
      const url = page.locator(site.queueUrl);
      await url.focus();
      const kb = { top: 24, height: height - 220 };
      await page.evaluate(({ top, height: h }) => {
        const v = new EventTarget();
        Object.assign(v, { height: h, width: innerWidth, offsetTop: top, offsetLeft: 0, scale: 1 });
        Object.defineProperty(window, "visualViewport", { configurable: true, value: v });
        window.dispatchEvent(new Event("resize"));
      }, kb);
      await expect(url).toBeFocused();
      await expect.poll(async () => { const b = await box(url); return b.y + b.height; }).toBeLessThanOrEqual(kb.top + kb.height);
      for (const l of [url, page.locator(site.queueAdd)]) await inside(l, kb.top, kb.top + kb.height);
    } finally {
      close();
    }
  });
}

test("844×390 with Twitch's taller TV: the room window holds a whole seat row beside its keys, nothing covers the keys, axe target-size clean (QA OME-1330 R1)", async ({ browser, request }) => {
  const page = await open(browser, "twitch", 844, 390);
  await shareProvider(request, providerCase("twitchVod").shareUrl, testRoom("landscape-phone", "twitch").id);
  await expect(page.locator(`${site.tv} iframe`)).toBeAttached({ timeout: 10_000 });
  const win = page.locator(site.roomWindow);
  await win.scrollIntoViewIfNeeded();
  await inside(win, 0, 390, 0, 844);
  // A whole row at least: four seats a finger can take.
  await expect.poll(() => page.locator(`${site.seat}:not([inert])`).count()).toBeGreaterThanOrEqual(4);
  for (const k of ["in", "out", "fit"]) await inside(page.locator(`[data-testid=room-zoom-${k}]`), 0, 390, 0, 844);
  const { violations } = await new AxeBuilder({ page }).include(site.room).withRules(["target-size"]).analyze();
  expect(violations.flatMap((v) => v.nodes.map((n) => `${n.target.join(" ")}: ${n.failureSummary ?? ""}`))).toEqual([]);
});

// vhourshelf: a Vimeo over an hour, played past 1:00:00, so both readouts are h:mm:ss, the widest they get (QA OME-1342).
for (const [name, key, at] of [["tvshelf", "twitchVod", 0], ["tliveshelf", "twitchLive", 0], ["vshelf", "vimeo", 0], ["vhourshelf", "vimeo", 3800]] as const) {
  test(`844×390 touch, ${name === "vhourshelf" ? "vimeo past an hour" : key}: no two boxes in the shelf overlap, each wholly in the shelf, axe clean on it (QA OME-1333)`, async ({ browser, request }) => {
    const page = await open(browser, name, 844, 390, at === 0 ? undefined : async (context) => { await context.route("https://player.vimeo.com/api/player.js", (route) =>
      route.fulfill({ contentType: "text/javascript", body: `${FAKE_VIMEO_SDK}\nwindow.__fakeVimeo.configure({ duration: 4000 });` })); });
    await shareProvider(request, providerCase(key).shareUrl, testRoom("landscape-phone", name).id);
    await expect(page.locator(`${site.tv} iframe`)).toBeAttached({ timeout: 10_000 });
    await expect(page.locator("[data-testid=provider-plate]")).toBeVisible();
    if (at > 0) {
      const seek = page.locator(site.seek);
      await expect(seek).toBeEnabled();
      await seek.fill(String(at));
      await expect(page.locator(".controls .ui-readout").first()).toHaveText(/^1:0\d:\d\d/);
      // The seek-only hint lands a beat later and takes its share of the row: measure with it in.
      await expect(page.getByTestId("seek-only-hint")).toBeVisible();
    }
    const clash = await page.locator(".controls").evaluate((shelf) => {
      const s = shelf.getBoundingClientRect();
      const units = [...shelf.querySelectorAll<HTMLElement>(".ui-chip, .ui-button, .ui-readout, .ui-seek, .ui-vol-track, .ui-live, .ui-hint, .ui-plate")]
        .filter((e) => e.checkVisibility() && e.getBoundingClientRect().width > 1);
      const name = (e: Element): string => `${e.className} ${e.getAttribute("data-testid") ?? ""}`.trim();
      const out: string[] = [];
      for (const [i, a] of units.entries()) {
        const r = a.getBoundingClientRect();
        if (r.left < s.left || r.right > s.right || r.top < s.top || r.bottom > s.bottom) out.push(`${name(a)} leaves the shelf`);
        for (const b of units.slice(i + 1)) {
          if (a.contains(b) || b.contains(a)) continue;
          const q = b.getBoundingClientRect();
          if (Math.min(r.right, q.right) - Math.max(r.left, q.left) > 0 && Math.min(r.bottom, q.bottom) - Math.max(r.top, q.top) > 0) out.push(`${name(a)} × ${name(b)}`);
        }
      }
      return out;
    });
    expect(clash).toEqual([]);
    // A seekable provider keeps a seek bar a finger can drag (QA OME-1337: Vimeo's collapsed to its thumb).
    if (key !== "twitchLive") expect((await box(page.locator(".controls .ui-seek"))).width).toBeGreaterThanOrEqual(44);
    // Each key's 44 px finger target stays clear of the next one's: their centres are at least 44 px apart (QA OME-1342).
    const centres = await page.locator(".controls .ui-button").evaluateAll((keys) => keys.filter((k) => k.checkVisibility() && k.getBoundingClientRect().width > 1)
      .map((k) => { const r = k.getBoundingClientRect(); return r.left + r.width / 2; }));
    expect(centres.slice(1).map((c, i) => c - (centres[i] ?? -Infinity)).filter((d) => d < 44)).toEqual([]);
    const { violations } = await new AxeBuilder({ page }).include(".controls").analyze();
    expect(violations.flatMap((v) => v.nodes.map((n) => `${v.id} ${n.target.join(" ")}`))).toEqual([]);
  });
}

// OME-1841 (responsive audit round 2): at 844×390 the room window was 154 px tall from y 270, so the column showed a 76 px
// strip of chair backs and only the + key; People squeezed Up next until its field and Add were clipped and the column
// scrolled the TV half off; the head row was a bare Copy key, a title cut to "QA own…" and an Up next card without its name.
test("844×390 touch, seated: the room window is wholly on screen with my avatar's tag in it and all three zoom keys", async ({ browser }) => {
  const page = await open(browser, "w844", 844, 390);
  await page.locator(`${site.seat}:not([inert])`).first().click();
  const win = page.locator(site.roomWindow);
  await inside(win, 0, 390, 0, 844);
  for (const k of ["in", "out", "fit"]) await inside(page.locator(`[data-testid=room-zoom-${k}]`), 0, 390, 0, 844);
  const nickname = clients[0]?.nickname ?? "";
  const tag = page.locator(site.nicknameTag).filter({ hasText: nickname });
  await expect.poll(async () => {
    const w = await box(win);
    const t = await box(tag);
    return t.y >= w.y && t.y + t.height <= w.y + w.height && t.x >= w.x && t.x + t.width <= w.x + w.width;
  }, { message: "my name tag inside the room window" }).toBe(true);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  expect(await page.locator("#room-root").evaluate((n) => n.scrollTop)).toBe(0);
});

test("844×390 touch, the owner: the head row labels Copy, keeps the title whole and Up next its heading; People leaves the TV and Up next's field alone", async ({ browser }) => {
  const { id, ownerToken, inviteKey, title } = ownedRoom("landown");
  clients = await joinRoom(browser, { roomUrl: `${URLS.web}/r/${id}`, count: 1, nicknamePrefix: `landown${String(test.info().retry)}${String(test.info().repeatEachIndex)}`,
    contextOptions: () => ({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }),
    setup: async (context) => { await context.addInitScript(([origin, key, value]) => {
      if (location.origin === origin && localStorage.getItem(key ?? "") === null) localStorage.setItem(key ?? "", value ?? "");
    }, [URLS.web, ROOM_SECRETS_STORAGE_KEY, JSON.stringify({ v: 1, rooms: { [id]: { ownerToken, inviteKey } } })]); } });
  const page = clients[0]?.page;
  if (page === undefined) throw new Error("no client");
  await expect(page.locator(site.chatInput)).toBeVisible();

  // The owner's room window is whole too (their bar under the room took its height).
  await inside(page.locator(site.roomWindow), 0, 390, 0, 844);
  for (const k of ["in", "out", "fit"]) await inside(page.locator(`[data-testid=room-zoom-${k}]`), 0, 390, 0, 844);
  // Copy says what it copies: the invite field or its label shows beside it.
  const copy = page.locator(site.inviteCopy);
  await inside(copy, 0, 390, 0, 844);
  const label = page.locator("#invite-label");
  expect(await page.locator(site.inviteLink).isVisible() || (await label.isVisible() && (await box(label)).width > 1), "the invite field or its label is visible").toBe(true);
  // The title shows whole: the room has the space for it.
  const roomTitle = page.locator(site.roomTitle);
  await expect(roomTitle).toHaveText(title);
  await inside(roomTitle, 0, 390, 0, 844);
  expect(await roomTitle.evaluate((n) => n.scrollWidth <= n.clientWidth), "title not cut").toBe(true);
  // Up next keeps its heading.
  const heading = page.locator(`${site.queuePanel} .queue-head h3`);
  await expect(heading).toHaveText("Up next");
  expect((await box(heading)).width).toBeGreaterThan(20);
  await inside(heading, 0, 390, 0, 844);

  // People opens as the column's tab: the TV stays put; Up next is either whole or out of the way, never clipped.
  const tv = await box(page.locator(site.tv));
  await page.locator(site.peopleKey).click();
  await expect(page.locator(site.peoplePanel)).toBeVisible();
  await page.waitForTimeout(300);
  expect(await box(page.locator(site.tv))).toEqual(tv);
  expect(await page.locator("#room-root").evaluate((n) => n.scrollTop)).toBe(0);
  for (const l of [site.queueUrl, site.queueAdd]) {
    if (await page.locator(l).isVisible()) await inside(page.locator(l), 0, 390, 0, 844);
  }
  await page.locator(site.peopleKey).click();
  await expect(page.locator(site.peoplePanel)).toBeHidden();
  for (const l of [site.queueUrl, site.queueAdd]) await inside(page.locator(l), 0, 390, 0, 844);
  expect(await box(page.locator(site.tv))).toEqual(tv);
});

test("844×390 touch: the footer gives the room its height; its pages, Source (AGPL §13) and Feedback included, are in Help", async ({ browser }) => {
  const page = await open(browser, "p844", 844, 390);
  await page.locator(site.helpKey).click();
  const dialog = page.locator(site.helpDialog);
  await expect(dialog).toBeVisible();
  for (const name of [/^Source/, /^Feedback/, /^Privacy/]) await expect(dialog.getByRole("link", { name })).toBeVisible();
});

// OME-1929 (responsive audit round 3): with a video, turned from portrait, the room window was 148 px from y 270, its foot
// 28 px past the screen and the Fit key cut: the reaction bar under it took 34 px. Loaded sideways, the window was whole
// (the bar came after the fit, under the fold). The phone window's height doesn't read the preset.
for (const who of ["guest", "owner"] as const) {
  test(`844×390 touch, a ${who} with a video: the room window and all three zoom keys are wholly on screen`, async ({ browser, request }) => {
    let page: Page;
    if (who === "guest") page = await open(browser, "v844", 844, 390);
    else {
      const { id, ownerToken, inviteKey } = ownedRoom("landvid");
      clients = await joinRoom(browser, { roomUrl: `${URLS.web}/r/${id}`, count: 1, nicknamePrefix: `landvid${String(test.info().retry)}${String(test.info().repeatEachIndex)}`,
        contextOptions: () => ({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }),
        setup: async (context) => { await context.addInitScript(([origin, key, value]) => {
          if (location.origin === origin && localStorage.getItem(key ?? "") === null) localStorage.setItem(key ?? "", value ?? "");
        }, [URLS.web, ROOM_SECRETS_STORAGE_KEY, JSON.stringify({ v: 1, rooms: { [id]: { ownerToken, inviteKey } } })]); } });
      const p = clients[0]?.page;
      if (p === undefined) throw new Error("no client");
      page = p;
    }
    const video = ["dQw4w9WgXcQ", "M7lc1UVf-VE", "aqz-KE-bpKQ"][test.info().retry] ?? "9bZkp7q19f0";
    if (who === "guest") await shareProvider(request, `https://youtu.be/${video}`, testRoom("landscape-phone", "v844").id);
    else {
      await page.locator(site.queueUrl).fill(`https://youtu.be/${video}`);
      await page.locator(site.queueAdd).click();
    }
    await expect(page.locator(site.sharedVideo)).toBeVisible();
    const whole = async (): Promise<void> => {
      await inside(page.locator(site.roomWindow), 0, 390, 0, 844);
      for (const k of ["in", "out", "fit"]) await inside(page.locator(`[data-testid=room-zoom-${k}]`), 0, 390, 0, 844);
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
      expect(await page.locator("#room-root").evaluate((n) => n.scrollTop)).toBe(0);
    };
    await whole();
    // Turned to portrait and back (the audit's path).
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator("#room-root")).toHaveClass(/room-portrait/);
    await page.setViewportSize({ width: 844, height: 390 });
    await expect(page.locator("#room-root")).toHaveClass(/room-wide/);
    await whole();
  });
}

// OME-1928: in the 279 px chat column a row for someone else carries three keys, and the name got what was left (3 px of
// "kitkatbar"). The keys wrap under the name instead, so the whole 9-letter name shows and every key stays 44×44.
test("844×390 touch, People: another member's 9-letter name shows whole beside or above its 44×44 keys", async ({ browser }) => {
  clients = await joinRoom(browser, { roomUrl: testRoom("landscape-phone", "n844").url, count: 2, nicknamePrefix: "kitkatb",
    contextOptions: () => ({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }) });
  const [a, b] = clients;
  if (a === undefined || b === undefined) throw new Error("no clients");
  expect(b.nickname).toHaveLength(9);
  await a.page.locator(site.peopleKey).click();
  const row = a.page.locator(site.peopleRow).filter({ hasText: b.nickname });
  await expect(row.getByRole("button")).toHaveCount(3);
  const name = row.locator(".people-name");
  await expect(name).toBeVisible();
  const fit = await name.evaluate((n) => ({ width: n.clientWidth, text: n.scrollWidth }));
  expect(fit.width, "the name's box covers its text").toBeGreaterThanOrEqual(fit.text);
  for (const k of await row.getByRole("button").all()) {
    const k44 = await box(k);
    expect(k44.width).toBeGreaterThanOrEqual(44);
    expect(k44.height).toBeGreaterThanOrEqual(44);
  }
});
