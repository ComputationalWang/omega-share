// OME-2196 (design judge round 4): in the busy room a front avatar's tag stacked over the tags behind it, nearer someone
// else's head than its own. Six members on a 2×3 block at 1280×800, Room view (the default) and the band: no two tags
// overlap, and each tag is nearest its own owner's head.
import { expect, test } from "./support/csp";
import { shareVideo, waitPlaying } from "../perf/sync";
import { PENDING, available } from "./support/apps";
import { joinRoom, leaveAll, testRoom, type Client } from "./support/room";
import { site } from "./support/selectors";
import { presetFile, showLayout } from "../perf/show-layout";
import { TAG_H, cellCenter } from "../apps/web/src/layout";
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
  return page.evaluate((down) => {
    const room = Reflect.get(Reflect.get(window, "__omega") ?? {}, "room") as { state: () => { room: { members: { id: string; nickname: string }[] } }; head: (id: string) => { x: number; y: number } | undefined };
    const floor = document.querySelector('[data-testid="walk-floor"]');
    if (!(floor instanceof HTMLElement)) return [];
    const f = floor.getBoundingClientRect();
    const k = f.width / floor.offsetWidth;
    const heads = room.state().room.members.flatMap((m) => {
      const h = room.head(m.id);
      return h === undefined ? [] : [{ name: m.nickname, x: f.left + h.x * k, y: f.top + (h.y + down) * k }];
    });
    return [...document.querySelectorAll<HTMLElement>(".tag")].map((e) => {
      const r = e.getBoundingClientRect();
      const [cx, cy] = [(r.left + r.right) / 2, (r.top + r.bottom) / 2];
      const nearest = heads.reduce((a, b) => (Math.hypot(b.x - cx, b.y - cy) < Math.hypot(a.x - cx, a.y - cy) ? b : a));
      return { name: e.querySelector(".tag-name")?.textContent ?? "", box: [r.left, r.top, r.right, r.bottom] as [number, number, number, number], nearest: nearest.name };
    });
  }, down);
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
  const tagBoxes = (): Promise<Record<string, B>> =>
    watcher.page.evaluate(() =>
      Object.fromEntries([...document.querySelectorAll<HTMLElement>(".tag")].map((e) => {
        const r = e.getBoundingClientRect();
        return [e.querySelector(".tag-name")?.textContent ?? "", { l: r.left, r: r.right, t: r.top, b: r.bottom }];
      })),
    );
  const tags = await tagBoxes();
  // The room without its tags (DOM over the canvas), as pixels.
  const shot = async (): Promise<Buffer> => {
    const hide = (on: boolean): Promise<void> =>
      watcher.page.evaluate((on) => {
        for (const e of document.querySelectorAll<HTMLElement>(".tag")) e.style.visibility = on ? "hidden" : "";
      }, on);
    await hide(true);
    await watcher.page.waitForTimeout(300);
    const png = await watcher.page.screenshot();
    await hide(false);
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
