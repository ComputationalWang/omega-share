// OME-2196 (design judge round 4): in the busy room a front avatar's tag stacked over the tags behind it, nearer someone
// else's head than its own. Six members on a 2×3 block at 1280×800, Room view (the default) and the band: no two tags
// overlap, and each tag is nearest its own owner's head.
import { devices, type BrowserContextOptions } from "@playwright/test";
import { expect, test } from "./support/csp";
import { shareVideo, waitPlaying } from "../perf/sync";
import { PENDING, available } from "./support/apps";
import { joinRoom, leaveAll, testRoom, type Client } from "./support/room";
import { site } from "./support/selectors";
import { hideTags, roomTags } from "./support/tag-stack";
import { presetFile, showLayout } from "../perf/show-layout";
import { STAGE_W, TAG_H, cellCenter } from "../apps/web/src/layout";
import { HEAD_H, HEAD_W, TAG_GAP } from "../apps/web/src/tag-stack";
import { EMOTE_LIFT } from "../apps/web/src/walk/animator";

test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);

let clients: Client[] = [];
test.afterEach(async () => {
  await leaveAll(clients);
  clients = [];
});

const CELLS = [[4, 4], [5, 4], [4, 5], [5, 5], [6, 4], [4, 6]] as const;

/** Each tag's box (CSS px) and whose head (by nickname) lies nearest its centre. */
async function tags(page: Client["page"]): Promise<{ name: string; box: [number, number, number, number]; nearest: string }[]> {
  // `head()` is the point over the tag on the head (stage.ts overOf); the head's centre is under that tag.
  const down = TAG_GAP + TAG_H + HEAD_H / 2;
  const heads = await page.evaluate((down) => {
    const room = Reflect.get(Reflect.get(window, "__omega") ?? {}, "room") as { state: () => { room: { members: { id: string; nickname: string }[] } }; head: (id: string) => { x: number; y: number } | undefined };
    const floor = document.querySelector('[data-testid="walk-floor"]');
    if (!(floor instanceof HTMLElement)) return [];
    const f = floor.getBoundingClientRect();
    const k = f.width / floor.offsetWidth;
    return room.state().room.members.flatMap((m) => {
      const h = room.head(m.id);
      return h === undefined ? [] : [{ name: m.nickname, x: f.left + h.x * k, y: f.top + (h.y + down) * k }];
    });
  }, down);
  return (await roomTags(page)).map(({ text, rect: r }) => {
    const [cx, cy] = [r.x + r.width / 2, r.y + r.height / 2];
    const nearest = heads.reduce((a, b) => (Math.hypot(b.x - cx, b.y - cy) < Math.hypot(a.x - cx, a.y - cy) ? b : a));
    return { name: text, box: [r.x, r.y, r.x + r.width, r.y + r.height] as [number, number, number, number], nearest: nearest.name };
  });
}

function overlapping(t: Awaited<ReturnType<typeof tags>>): string[] {
  return t.flatMap((a, i) => t.slice(i + 1).filter((b) => a.box[0] < b.box[2] && b.box[0] < a.box[2] && a.box[1] < b.box[3] && b.box[1] < a.box[3]).map((b) => `${a.name}×${b.name}`));
}

async function clickCell(page: Client["page"], x: number, y: number): Promise<void> {
  const box = await page.locator(site.walkFloor).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, k: r.width / (el as HTMLElement).offsetWidth };
  });
  const p = cellCenter(x, y);
  await page.mouse.click(box.left + p.x * box.k, box.top + p.y * box.k);
}

test("six tags on a 2×3 block: none overlap, each nearest its own head, in Room view and the band", async ({ browser, request }) => {
  test.setTimeout(90_000);
  const room = testRoom("tag-clusters", "busy");
  // A video playing: the Room view key shows (the band is the other choice), and Room view opens first at 1280 (OME-2195).
  await shareVideo(request, room.id);
  clients = await joinRoom(browser, { roomUrl: room.url, count: 6, nicknamePrefix: "t", contextOptions: () => ({ viewport: { width: 1280, height: 800 } }) });
  const [watcher] = clients;
  if (watcher === undefined) throw new Error("no client");
  await waitPlaying([watcher]);
  for (const [i, c] of clients.entries()) {
    const [x, y] = CELLS[i] ?? [3, 3];
    await clickCell(c.page, x, y);
  }
  // Everyone is on their cell: stage.ts `head` is the anchor less the lift (a sitter's is lower: two cells have armchairs),
  // the gap and the tag.
  const want = CELLS.map(([x, y]) => cellCenter(x, y)).map((p) => `${String(Math.round(p.x))},${String(Math.round(p.y))}`).sort();
  await expect
    .poll(async () => {
      const heads = await watcher.page.evaluate(() => {
        const room = Reflect.get(Reflect.get(window, "__omega") ?? {}, "room") as { state: () => { room: { members: { id: string }[] } }; head: (id: string) => { x: number; y: number } | undefined };
        return room.state().room.members.flatMap((m) => room.head(m.id) ?? []);
      });
      return heads
        .map((h) => {
          const at = (lift: number): string => `${String(Math.round(h.x))},${String(Math.round(h.y + lift + TAG_GAP + TAG_H))}`;
          return want.includes(at(EMOTE_LIFT.sit)) ? at(EMOTE_LIFT.sit) : at(EMOTE_LIFT.idle);
        })
        .sort();
    }, { timeout: 20_000 })
    .toEqual(want);
  const settled = async (): Promise<Awaited<ReturnType<typeof tags>>> => {
    let t: Awaited<ReturnType<typeof tags>> = [];
    await expect
      .poll(async () => {
        t = await tags(watcher.page);
        return { n: t.length, overlapping: overlapping(t), astray: t.filter((x) => x.nearest !== x.name).map((x) => `${x.name}→${x.nearest}`) };
      }, { timeout: 20_000 })
      .toEqual({ n: 6, overlapping: [], astray: [] });
    return t;
  };
  await expect(watcher.page.locator(site.roomViewKey)).toHaveAttribute("aria-pressed", "true");
  await settled();
  await watcher.page.locator(site.roomViewKey).click();
  await expect(watcher.page.locator(site.roomViewKey)).toHaveAttribute("aria-pressed", "false");
  await settled();
});

// OME-2246 (judge round 7 on OME-2061, busy-seated-classic-1280x800): six members seated in the classic room, Room view at
// 1280×800. Two back-row tags floated ~120 px over their heads and the front row's over the back row's chairs.
// OME-2252 (judge round 8): the tags sat on the nominal 24×24 head box, 12–14 px over the drawn hair, so the front row's
// read as the back row's. Measured on the pixels: each sitter's head top is the highest row where the room with them seated
// differs from the room once they've left (tags hidden), in their column. Each tag's bottom sits 2–6 px over it, its centre
// nearer its own head than any other, and no tag covers another tag or another sitter's head.
test("six seated in classic at 1280×800: each tag 2–6 px over its drawn head, nearest its own, over no other head or tag", async ({ browser, request }) => {
  test.setTimeout(120_000);
  const room = testRoom("tag-clusters", "seated");
  await shareVideo(request, room.id);
  const layout = presetFile("classic");
  // Six sitters and a watcher who stays standing, so the empty chairs can be seen once the sitters leave. Reduced motion:
  // no breathing, so both shots catch the same frame.
  clients = await joinRoom(browser, { roomUrl: room.url, count: 7, nicknamePrefix: "s", setup: (context) => showLayout(context, layout), contextOptions: () => ({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" }) });
  const watcher = clients[6];
  const sitters = clients.slice(0, 6);
  if (watcher === undefined) throw new Error("no client");
  await waitPlaying([watcher]);
  await expect(watcher.page.locator(site.roomViewKey)).toHaveAttribute("aria-pressed", "true");
  // The watcher stands in the far corner, clear of every seat's column.
  await clickCell(watcher.page, 9, 9);
  // One at a time, as the judge's run did: each walk ends before the next starts.
  for (const [i, c] of sitters.entries()) {
    await c.page.locator(`${site.seat}[data-seat="${String(i)}"]`).click({ force: true });
    await c.page.waitForTimeout(1500);
  }
  await expect.poll(() => watcher.page.evaluate(() => (Reflect.get(Reflect.get(window, "__omega") ?? {}, "room") as { state: () => { room: { seats: (string | null)[] } } }).state().room.seats.filter((s) => s !== null).length), { timeout: 20_000 }).toBe(6);
  /** Each member's anchor (CSS px: `head()` less the seated lift, gap and tag) and the CSS px per stage px. */
  const anchors = (): Promise<{ k: number; at: Record<string, { x: number; y: number }> }> =>
    watcher.page.evaluate(
      (up) => {
        const room = Reflect.get(Reflect.get(window, "__omega") ?? {}, "room") as { state: () => { room: { members: { id: string; nickname: string }[] } }; head: (id: string) => { x: number; y: number } | undefined };
        const floor = document.querySelector('[data-testid="walk-floor"]');
        if (!(floor instanceof HTMLElement)) return { k: 0, at: {} };
        const f = floor.getBoundingClientRect();
        const k = f.width / floor.offsetWidth;
        const at: Record<string, { x: number; y: number }> = {};
        for (const m of room.state().room.members) {
          const h = room.head(m.id);
          if (h !== undefined) at[m.nickname] = { x: f.left + h.x * k, y: f.top + (h.y + up) * k };
        }
        return { k, at };
      },
      EMOTE_LIFT.sit + TAG_GAP + TAG_H,
    );
  // Everyone in their chair: no head moves for longer than a walk's tag takes to settle (stage.ts TAG_SETTLE_MS).
  await expect
    .poll(async () => {
      const a = JSON.stringify(await anchors());
      await watcher.page.waitForTimeout(1500);
      return a === JSON.stringify(await anchors());
    }, { timeout: 30_000 })
    .toBe(true);
  const { k, at } = await anchors();
  const names = sitters.map((c) => c.nickname).filter((n) => n in at);
  expect(names.length, JSON.stringify(Object.keys(at))).toBe(6);
  interface B { l: number; r: number; t: number; b: number }
  const tagBoxes = async (): Promise<Record<string, B>> =>
    Object.fromEntries((await roomTags(watcher.page)).map(({ text, rect: r }) => [text, { l: r.x, r: r.x + r.width, t: r.y, b: r.y + r.height }]));
  const tags = await tagBoxes();
  // The room without its tags (painted on the canvas, OME-2307), as pixels.
  const shot = async (): Promise<Buffer> => {
    await hideTags(watcher.page, true);
    await watcher.page.waitForTimeout(300);
    const png = await watcher.page.screenshot();
    await hideTags(watcher.page, false);
    return png;
  };
  const seated = await shot();
  await leaveAll(sitters);
  await expect.poll(() => watcher.page.evaluate(() => (Reflect.get(Reflect.get(window, "__omega") ?? {}, "room") as { state: () => { room: { members: unknown[] } } }).state().room.members.length), { timeout: 20_000 }).toBe(1);
  await watcher.page.waitForTimeout(1500);
  const empty = await shot();
  // Each sitter's drawn head top (CSS px): the first row, from 70 stage px over the anchor down, where a pixel in its column
  // (±12 stage px) changed when they left.
  const tops = await watcher.page.evaluate(
    async ({ a, b, cols, k }) => {
      const px = async (b64: string): Promise<{ d: Uint8ClampedArray; w: number }> => {
        const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))], { type: "image/png" }));
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const g = c.getContext("2d");
        if (g === null) throw new Error("no 2d");
        g.drawImage(bmp, 0, 0);
        return { d: g.getImageData(0, 0, bmp.width, bmp.height).data, w: bmp.width };
      };
      const [s, e] = [await px(a), await px(b)];
      const out: Record<string, number> = {};
      for (const [name, p] of Object.entries(cols)) {
        rows: for (let y = Math.round(p.y - 70 * k); y < Math.round(p.y - 10 * k); y++)
          for (let x = Math.round(p.x - 12 * k); x <= Math.round(p.x + 12 * k); x++) {
            const i = (y * s.w + x) * 4;
            if (Math.abs((s.d[i] ?? 0) - (e.d[i] ?? 0)) + Math.abs((s.d[i + 1] ?? 0) - (e.d[i + 1] ?? 0)) + Math.abs((s.d[i + 2] ?? 0) - (e.d[i + 2] ?? 0)) > 24) {
              out[name] = y;
              break rows;
            }
          }
      }
      return out;
    },
    { a: seated.toString("base64"), b: empty.toString("base64"), cols: Object.fromEntries(names.map((n) => [n, at[n] ?? { x: 0, y: 0 }])), k },
  );
  const heads = Object.fromEntries(names.map((n): [string, B] => {
    const x = at[n]?.x ?? 0;
    const t = tops[n] ?? 0;
    return [n, { l: x - (HEAD_W / 2) * k, r: x + (HEAD_W / 2) * k, t, b: t + HEAD_H * k }];
  }));
  const hit = (a: B, b: B): boolean => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
  const centre = (b: B): [number, number] => [(b.l + b.r) / 2, (b.t + b.b) / 2];
  const out: string[] = [];
  for (const n of names) {
    const t = tags[n];
    const h = heads[n];
    if (t === undefined || h === undefined || tops[n] === undefined) {
      out.push(`${n}: no tag or head`);
      continue;
    }
    const gap = (h.t - t.b) / k;
    if (gap < 2 || gap > 6) out.push(`${n}: tag ${gap.toFixed(1)} px over its drawn head`);
    const [cx, cy] = centre(t);
    const d = (o: B): number => Math.hypot((o.l + o.r) / 2 - cx, (o.t + o.b) / 2 - cy);
    for (const m of names) {
      const o = heads[m];
      if (m === n || o === undefined) continue;
      if (d(o) <= d(h)) out.push(`${n}'s tag nearer ${m}'s head`);
      if (hit(t, o)) out.push(`${n} covers ${m}'s head`);
      const u = tags[m];
      if (u !== undefined && n < m && hit(t, u)) out.push(`${n}×${m}`);
    }
  }
  expect(out, JSON.stringify({ tags, tops, at })).toEqual([]);
});

// OME-2307 (Doorstep desk 3): the tags are painted on the room canvas (the `tag/0` / `tag/self` frames), so walking moves
// one scene, not a DOM box per walker per frame. The DOM keeps a transparent target per tag (moderation, focus) that
// paints nothing; hiding the painted tags changes the canvas inside every tag's box.
test("tags are painted on the canvas: the DOM tag paints nothing, hiding the painted ones changes their pixels", async ({ browser, request }) => {
  test.setTimeout(60_000);
  const room = testRoom("tag-clusters", "painted");
  await shareVideo(request, room.id);
  clients = await joinRoom(browser, { roomUrl: room.url, count: 2, nicknamePrefix: "p", contextOptions: () => ({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" }) });
  const [watcher, other] = clients;
  if (watcher === undefined || other === undefined) throw new Error("no client");
  await waitPlaying([watcher]);
  await clickCell(other.page, 6, 6);
  // Every tag, mine included.
  await expect.poll(async () => (await roomTags(watcher.page)).map((t) => t.text).sort(), { timeout: 15_000 }).toEqual([other.nickname, watcher.nickname].sort());
  const dom = await watcher.page.locator(site.nicknameTag).first().evaluate((e) => {
    const s = getComputedStyle(e);
    return { border: s.borderImageSource, color: s.color, underline: getComputedStyle(e, "::after").content };
  });
  expect(dom, "the DOM tag is a bare target").toEqual({ border: "none", color: "rgba(0, 0, 0, 0)", underline: "none" });
  // The video plays, so the room is dimmed: in the scene, under the painted tags, not by a DOM layer over them.
  await expect(watcher.page.locator(".cinema-dim.is-on")).toHaveCSS("box-shadow", /rgba\(8, 6, 18, 0\.45\)/);
  await expect(watcher.page.locator(".cinema-dim.is-on")).toHaveCSS("background-color", "rgba(8, 6, 18, 0)");
  await watcher.page.waitForTimeout(1500);
  const shown = await watcher.page.screenshot();
  await hideTags(watcher.page, true);
  const hidden = await watcher.page.screenshot();
  await hideTags(watcher.page, false);
  const rects = (await roomTags(watcher.page)).map((t) => t.rect);
  // How many pixels inside each tag's box differ between the two shots.
  const changed = await watcher.page.evaluate(
    async ({ a, b, rects }) => {
      const px = async (b64: string): Promise<{ d: Uint8ClampedArray; w: number }> => {
        const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))], { type: "image/png" }));
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const g = c.getContext("2d");
        if (g === null) throw new Error("no 2d");
        g.drawImage(bmp, 0, 0);
        return { d: g.getImageData(0, 0, bmp.width, bmp.height).data, w: bmp.width };
      };
      const [s, h] = [await px(a), await px(b)];
      return rects.map((r) => {
        let n = 0;
        for (let y = Math.ceil(r.y); y < Math.floor(r.y + r.height); y++)
          for (let x = Math.ceil(r.x); x < Math.floor(r.x + r.width); x++) {
            const i = (y * s.w + x) * 4;
            if (s.d[i] !== h.d[i] || s.d[i + 1] !== h.d[i + 1] || s.d[i + 2] !== h.d[i + 2]) n++;
          }
        return n;
      });
    },
    { a: shown.toString("base64"), b: hidden.toString("base64"), rects },
  );
  for (const n of changed) expect(n, "painted pixels in a tag's box").toBeGreaterThan(50);
});

// OME-2424: the transparent DOM target kept `.ui-tag`'s slice in the build (lightningcss minified `border-image: none` into
// an invalid `border-image:`) and covered every painted name with a blank plate. Run against the preview build to see it.
for (const [label, options] of [
  ["1280×800", { viewport: { width: 1280, height: 800 } }],
  ["Pixel 7", devices["Pixel 7"]],
] as const satisfies readonly (readonly [string, BrowserContextOptions])[]) {
  test(`${label}: every tag's name shows in its painted box, no DOM plate over it`, async ({ browser }) => {
    test.setTimeout(60_000);
    const room = testRoom("tag-clusters", `names-${label === "Pixel 7" ? "phone" : "desk"}`);
    clients = await joinRoom(browser, { roomUrl: room.url, count: 2, nicknamePrefix: "nm", contextOptions: () => ({ ...options, reducedMotion: "reduce" }) });
    const [watcher, other] = clients;
    if (watcher === undefined || other === undefined) throw new Error("no client");
    await expect.poll(async () => (await roomTags(watcher.page)).map((t) => t.text).sort(), { timeout: 15_000 }).toEqual([other.nickname, watcher.nickname].sort());
    const plates = await watcher.page.locator(site.nicknameTag).evaluateAll((es) => es.map((e) => ({ self: e.classList.contains("self"), source: getComputedStyle(e).borderImageSource })));
    expect(plates.some((p) => p.self) && plates.some((p) => !p.self), "a self tag and a plain one").toBe(true);
    for (const p of plates) expect.soft(p.source, `${p.self ? "self" : "plain"} tag's DOM target`).toBe("none");
    await watcher.page.waitForTimeout(1000);
    const shot = await watcher.page.screenshot();
    const painted = await roomTags(watcher.page);
    // Pixels in each painted tag's box in the tag text's colour: #e8b33c for mine, #fff7ea for the others.
    const counts = await watcher.page.evaluate(
      async ({ b64, tags }) => {
        const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))], { type: "image/png" }));
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const g = c.getContext("2d");
        if (g === null) throw new Error("no 2d");
        g.drawImage(bmp, 0, 0);
        const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
        const k = bmp.width / innerWidth;
        return tags.map(({ text, self, r }) => {
          const want = self ? [0xe8, 0xb3, 0x3c] : [0xff, 0xf7, 0xea];
          let n = 0;
          for (let y = Math.ceil(r.y * k); y < Math.floor((r.y + r.height) * k); y++)
            for (let x = Math.ceil(r.x * k); x < Math.floor((r.x + r.width) * k); x++) {
              const i = (y * bmp.width + x) * 4;
              if (want.every((w, j) => Math.abs((d[i + j] ?? 0) - w) <= 8)) n++;
            }
          return { text, n };
        });
      },
      { b64: shot.toString("base64"), tags: painted.map((t) => ({ text: t.text, self: t.text === watcher.nickname, r: t.rect })) },
    );
    for (const { text, n } of counts) expect(n, `name-coloured pixels in ${text}'s tag`).toBeGreaterThanOrEqual(20);
  });
}

// OME-2518 (judge OME-2516, w31-cafe-pixel7-4-seated): on Pixel 7 with four guests on the Café's seats 0–3, one tag stacked
// up to the back wall, far over its avatar, and the others covered the counter. Each tag's centre lies within one stack
// step (1.5 tag heights and two gaps) of its owner's head box (over it, one step up, beside it or under the feet), wears a leader pip once it's off the head,
// and covers no other tag.
/** Where the viewer stands in turn: the judge's spot by the front table, in front of the left table, by the lamp. */
const VIEWER_CELLS = [[5, 8], [4, 5], [3, 6], [1, 8], [2, 7]] as const;

test("Pixel 7, Café, four seated: each tag near its own head, led when moved, none overlap", async ({ browser, request }) => {
  test.setTimeout(120_000);
  const room = testRoom("tag-clusters", "cafe-phone");
  await shareVideo(request, room.id);
  const layout = presetFile("cafe");
  // QA's setup: four guests on seats 0–3 (stools at the counter, the left table's wingbacks) and a viewer who stands.
  clients = await joinRoom(browser, { roomUrl: room.url, count: 5, nicknamePrefix: "guest", setup: (context) => showLayout(context, layout), contextOptions: () => ({ ...devices["Pixel 7"], reducedMotion: "reduce" }) });
  const watcher = clients[4];
  if (watcher === undefined) throw new Error("no client");
  // The phone shows part of the room: a seat key off screen is clicked in the page, as a tap after panning would.
  for (const [i, c] of clients.slice(0, 4).entries()) {
    await c.page.locator(`${site.seat}[data-seat="${String(i)}"]`).evaluate((e) => {
      (e as HTMLElement).click();
    });
    await c.page.waitForTimeout(1500);
  }
  await expect.poll(() => watcher.page.evaluate(() => (Reflect.get(Reflect.get(window, "__omega") ?? {}, "room") as { state: () => { room: { seats: (string | null)[] } } }).state().room.seats.filter((s) => s !== null).length), { timeout: 20_000 }).toBe(4);
  /** Each member's `head()` (CSS px: the top centre of a tag over the head) and the CSS px per stage px. */
  const heads = (): Promise<{ k: number; at: Record<string, { x: number; y: number }> }> =>
    watcher.page.evaluate((stageW) => {
      const room = Reflect.get(Reflect.get(window, "__omega") ?? {}, "room") as { state: () => { room: { members: { id: string; nickname: string }[] } }; head: (id: string) => { x: number; y: number } | undefined };
      // The canvas is the stage, CSS-scaled and zoomed on a phone (stage.ts tagRects).
      const canvas = document.querySelector("canvas.scene");
      if (canvas === null) return { k: 0, at: {} };
      const c = canvas.getBoundingClientRect();
      const k = c.width / stageW;
      const at: Record<string, { x: number; y: number }> = {};
      for (const m of room.state().room.members) {
        const h = room.head(m.id);
        if (h !== undefined) at[m.nickname] = { x: c.left + h.x * k, y: c.top + h.y * k };
      }
      return { k, at };
    }, STAGE_W);
  const report = async (): Promise<string[]> => {
    const { k, at } = await heads();
    const tags = await roomTags(watcher.page);
    const out: string[] = [];
    if (tags.length !== 5) out.push(`${String(tags.length)} tags`);
    for (const t of tags) {
      const h = at[t.text];
      if (h === undefined) {
        out.push(`${t.text}: no head`);
        continue;
      }
      const r = t.rect;
      // The head box: HEAD_W wide, HEAD_H tall, under a tag over it (TAG_GAP under `head()`'s tag).
      const top = h.y + r.height + TAG_GAP * k;
      const [cx, cy] = [r.x + r.width / 2, r.y + r.height / 2];
      const dx = Math.max(0, Math.abs(cx - h.x) - (HEAD_W / 2) * k);
      const dy = Math.max(0, top - cy, cy - (top + HEAD_H * k));
      const far = Math.hypot(dx, dy) / r.height;
      // tag-stack reachOf: a tag stacked once over the one on the head.
      if (far > 1.5 + (2 * TAG_GAP * k) / r.height) out.push(`${t.text}: ${far.toFixed(2)} tag heights off its head`);
      // stackTags' NEAR: a tag off its head's width, or more than 12 stage px over or under it, wears the pip.
      const offHead = r.x + r.width < h.x - (HEAD_W / 2) * k || h.x + (HEAD_W / 2) * k < r.x || Math.max(top - (r.y + r.height), r.y - (top + HEAD_H * k)) > 12 * k;
      if (offHead && !t.led) out.push(`${t.text}: moved, no pip`);
      for (const u of tags) if (t.text < u.text && r.x < u.rect.x + u.rect.width && u.rect.x < r.x + r.width && r.y < u.rect.y + u.rect.height && u.rect.y < r.y + r.height) out.push(`${t.text}×${u.text}`);
    }
    return out;
  };
  // Fitted whole, as the judge's shot was: as the phone opens the room, the sitters are off its window.
  await watcher.page.getByTestId("room-zoom-fit").click();
  for (const [x, y] of VIEWER_CELLS) {
    await clickCell(watcher.page, x, y);
    // The walk ends and the tags restack (stage.ts TAG_SETTLE_MS) before the check holds.
    await watcher.page.waitForTimeout(2500);
    await expect.poll(report, { message: `viewer on ${String(x)},${String(y)}`, timeout: 10_000 }).toEqual([]);
  }
});
