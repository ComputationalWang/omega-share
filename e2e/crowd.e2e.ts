// OME-2428 (audit round 4 #4, OME-2420): 20 members chatting in the cinema at 1280×800 showed 15 bubbles, 13 of them
// over other members' tags, bubbles cut at the stage's sides, and the theatre rows' tags piled on each other. Here 19
// raw-socket members (8 on the theatre rows' seats, 11 standing among them) and one browser member: while they chat, no
// bubble is cut by the room's clip, at most 8 show, none covers another member's tag, and no two tags overlap by more
// than a quarter of the smaller. The frame rows are perf/'s (chat.perf.ts, theatre.perf.ts).
// OME-2459: the same at seeded random standable spots (cinema and studio): the fixture's spots were gentler than real rooms.
import { readFileSync } from "node:fs";
import { devices, type APIRequestContext, type Browser, type BrowserContextOptions, type Page } from "@playwright/test";
import * as v from "valibot";
import { FLOOR_CELLS, RoomLayoutSchema, isStandable, type FloorCell } from "@omega/shared";
import { expect, test } from "./support/csp";
import { shareVideo, waitPlaying } from "../perf/sync";
import { PENDING, available } from "./support/apps";
import { spawnBots, type BotSpec, type Bots } from "./support/bots";
import { joinRoom, leaveAll, testRoom, type Client } from "./support/room";

test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);

let clients: Client[] = [];
let bots: Bots | null = null;
test.afterEach(async () => {
  await leaveAll(clients);
  clients = [];
  await bots?.close();
  bots = null;
});

/** Around the theatre rows (assets/presets/cinema.json: rows at 1–2,4 / 2–3,6 / 4,1–2 / 6,2–3), all standable. */
const STANDING = [[1, 5], [2, 5], [3, 5], [3, 4], [1, 7], [2, 7], [3, 7], [5, 1], [5, 2], [5, 3], [7, 2]] as const;
const SPECS: BotSpec[] = [
  ...Array.from({ length: 8 }, (_, i) => ({ nickname: `crowd${String(i + 1)}x${"abcdefgh".slice(0, i % 8)}`, seat: i })),
  ...STANDING.map(([x, y], i) => ({ nickname: `stand${String(i + 1)}x${"abcdefgh".slice(0, (i + 3) % 8)}`, cell: { x, y } })),
];

interface Worst {
  shown: number;
  clipped: string[];
  overTag: string[];
  tagPairs: string[];
}

/** Samples the room every 100 ms for `ms`: the most bubbles shown at once, and every violation seen. */
function sample(page: Page, ms: number): Promise<Worst> {
  return page.evaluate(async (ms) => {
    const room = Reflect.get(Reflect.get(window, "__omega") ?? {}, "room") as { tags: () => { text: string; rect: { x: number; y: number; width: number; height: number } }[] };
    const clip = document.querySelector(".stage-clip");
    const worst = { shown: 0, clipped: new Set<string>(), overTag: new Set<string>(), tagPairs: new Set<string>() };
    const area = (a: DOMRectReadOnly | { x: number; y: number; width: number; height: number }, b: typeof a): number =>
      Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
    const end = performance.now() + ms;
    while (performance.now() < end) {
      const c = clip?.getBoundingClientRect();
      const tags = room.tags();
      const bubbles = [...document.querySelectorAll(".bubbles .ui-float.is-live:not(.is-leaving)")].flatMap((e) => {
        const r = e.getBoundingClientRect();
        const text = e.querySelector("[data-testid=chat-message]")?.textContent ?? "";
        return r.width > 0 ? [{ r, who: text.split(" ")[0] ?? "", text }] : [];
      });
      worst.shown = Math.max(worst.shown, bubbles.length);
      // Walking (and just stopped: TAG_SETTLE_MS) tags ride over heads and cross in passing; only standing members count.
      const walking = new Set([...document.querySelectorAll("[data-testid=nickname-tag].walking .tag-name")].map((e) => e.textContent));
      for (const b of bubbles) {
        // Cut: partly in the clip, partly out (1 px slack for rounding). A walker's too.
        if (c !== undefined && area(b.r, c) > 0 && (b.r.left < c.left - 1 || b.r.right > c.right + 1 || b.r.top < c.top - 1 || b.r.bottom > c.bottom + 1)) worst.clipped.add(b.text);
        if (walking.has(b.who)) continue;
        for (const t of tags) if (t.text !== b.who && !walking.has(t.text) && area(b.r, { x: t.rect.x + 1, y: t.rect.y + 1, width: t.rect.width - 2, height: t.rect.height - 2 }) > 0) worst.overTag.add(`${b.text} / ${t.text}`);
      }
      const still = tags.filter((t) => !walking.has(t.text));
      for (const [i, a] of still.entries()) {
        for (const b of still.slice(i + 1)) {
          const smaller = Math.min(a.rect.width * a.rect.height, b.rect.width * b.rect.height);
          if (area(a.rect, b.rect) > smaller / 4) worst.tagPairs.add(`${a.text}×${b.text}`);
        }
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return { shown: worst.shown, clipped: [...worst.clipped], overTag: [...worst.overTag], tagPairs: [...worst.tagPairs] };
  }, ms);
}

/**
 * 20 in `room` at `options`: 19 bots as `specs` and one browser member chat; the sampler holds for 12 s. With `moves`,
 * each bot walks on to its move while the talk runs, and the sampler starts once they stand: lines said on the way are
 * still up, so it holds for those bubbles' whole life too (OME-2459).
 */
async function crowd(browser: Browser, request: APIRequestContext, room: ReturnType<typeof testRoom>, specs: readonly BotSpec[], options: BrowserContextOptions, phone: boolean, moves: readonly FloorCell[] = []): Promise<void> {
  test.setTimeout(120_000);
  await shareVideo(request, room.id);
  const crowdBots = await spawnBots(browser, room.id, [...specs]);
  bots = crowdBots;
  expect(crowdBots.joined).toBe(specs.length);
  clients = await joinRoom(browser, { roomUrl: room.url, count: 1, nicknamePrefix: "me", contextOptions: () => options });
  const [me] = clients;
  if (me === undefined) throw new Error("no client");
  await waitPlaying([me]);
  // Everyone has walked to their place.
  await me.page.waitForTimeout(4000);
  // Each member says a line every 4 s, one every 200 ms; the bubble's first word is its speaker's tag.
  const lines = moves.length === 0 ? 60 : 85;
  const talk = (async () => {
    for (let k = 0; k < lines; k++) {
      const i = k % specs.length;
      await crowdBots.say(i, `${specs[i]?.nickname ?? ""} says line ${String(k)}, how is it going over there`);
      // One walks on every 200 ms, alongside the first lines.
      const to = moves[k];
      if (to !== undefined) await crowdBots.walk(k, to);
      await me.page.waitForTimeout(200);
    }
  })();
  // The last walk (sent ~4 s in) has ended; the lines said on the way are still up.
  if (moves.length > 0) await me.page.waitForTimeout(moves.length * 200 + 3000);
  const worst = await sample(me.page, 12_000);
  await talk;
  expect({ clipped: worst.clipped, overTag: worst.overTag, tagPairs: worst.tagPairs }).toEqual({ clipped: [], overTag: [], tagPairs: [] });
  expect(worst.shown).toBeLessThanOrEqual(8);
  // On the phone the zoomed window is all tags: a line that can't clear one shows in the chat log only.
  if (!phone) expect(worst.shown).toBeGreaterThan(0);
}

for (const [name, room, options] of [
  ["1280×800", testRoom("crowd", "cinema"), { viewport: { width: 1280, height: 800 } }],
  ["Pixel 7", testRoom("crowd", "phone"), devices["Pixel 7"]],
] as const satisfies readonly (readonly [string, ReturnType<typeof testRoom>, BrowserContextOptions])[]) {
  test(`20 chatting in the cinema at ${name}: no bubble cut or over a tag, at most 8, tags apart`, async ({ browser, request }) => {
    await crowd(browser, request, room, SPECS, options, name !== "1280×800");
  });
}

/** Mulberry32: the same spots every run. */
function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `preset`'s standable cells, shuffled with `rand`. */
function shuffled(preset: string, rand: () => number): FloorCell[] {
  const layout = v.parse(RoomLayoutSchema, JSON.parse(readFileSync(new URL(`../assets/presets/${preset}.json`, import.meta.url), "utf8")));
  const cells: FloorCell[] = [];
  for (let x = 0; x < FLOOR_CELLS; x++) for (let y = 0; y < FLOOR_CELLS; y++) if (isStandable(layout, { x, y })) cells.push({ x, y });
  for (let i = cells.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const a = cells[i];
    const b = cells[j];
    if (a === undefined || b === undefined) continue;
    cells[i] = b;
    cells[j] = a;
  }
  return cells;
}

for (const [preset, room] of [
  ["cinema", testRoom("crowd", "random")],
  ["studio", testRoom("crowd", "studio")],
] as const) {
  test(`20 chatting at seeded random spots in the ${preset} at 1280×800: no bubble cut or over a tag, tags apart`, async ({ browser, request }) => {
    const rand = seeded(2459);
    const specs = shuffled(preset, rand).slice(0, 19).map((cell, i) => ({ nickname: `${preset.slice(0, 3)}${String(i + 1)}x${"abcdefgh".slice(0, i % 8)}`, cell }));
    await crowd(browser, request, room, specs, { viewport: { width: 1280, height: 800 } }, false, shuffled(preset, rand).slice(0, 19));
  });
}
