// OME-2196 (design judge round 4): in the busy room a front avatar's tag stacked over the tags behind it, nearer someone
// else's head than its own. Six members on a 2×3 block at 1280×800, Room view (the default) and the band: no two tags
// overlap, and each tag is nearest its own owner's head.
import { expect, test } from "./support/csp";
import { shareVideo, waitPlaying } from "../perf/sync";
import { PENDING, available } from "./support/apps";
import { joinRoom, leaveAll, testRoom, type Client } from "./support/room";
import { site } from "./support/selectors";
import { TAG_H, cellCenter } from "../apps/web/src/layout";
import { HEAD_H, TAG_GAP } from "../apps/web/src/tag-stack";
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
