// OME-2428 (audit round 4 #4, OME-2420): 20 members chatting in the cinema at 1280×800 showed 15 bubbles, 13 of them
// over other members' tags, bubbles cut at the stage's sides, and the theatre rows' tags piled on each other. Here 19
// raw-socket members (8 on the theatre rows' seats, 11 standing among them) and one browser member: while they chat, no
// bubble is cut by the room's clip, at most 8 show, none covers another member's tag, and no two tags overlap by more
// than a quarter of the smaller. The frame rows are perf/'s (chat.perf.ts, theatre.perf.ts).
import { devices, type BrowserContextOptions, type Page } from "@playwright/test";
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
      for (const b of bubbles) {
        // Cut: partly in the clip, partly out (1 px slack for rounding).
        if (c !== undefined && area(b.r, c) > 0 && (b.r.left < c.left - 1 || b.r.right > c.right + 1 || b.r.top < c.top - 1 || b.r.bottom > c.bottom + 1)) worst.clipped.add(b.text);
        for (const t of tags) if (t.text !== b.who && area(b.r, { x: t.rect.x + 1, y: t.rect.y + 1, width: t.rect.width - 2, height: t.rect.height - 2 }) > 0) worst.overTag.add(`${b.text} / ${t.text}`);
      }
      for (const [i, a] of tags.entries()) {
        for (const b of tags.slice(i + 1)) {
          const smaller = Math.min(a.rect.width * a.rect.height, b.rect.width * b.rect.height);
          if (area(a.rect, b.rect) > smaller / 4) worst.tagPairs.add(`${a.text}×${b.text}`);
        }
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return { shown: worst.shown, clipped: [...worst.clipped], overTag: [...worst.overTag], tagPairs: [...worst.tagPairs] };
  }, ms);
}

for (const [name, room, options] of [
  ["1280×800", testRoom("crowd", "cinema"), { viewport: { width: 1280, height: 800 } }],
  ["Pixel 7", testRoom("crowd", "phone"), devices["Pixel 7"]],
] as const satisfies readonly (readonly [string, ReturnType<typeof testRoom>, BrowserContextOptions])[]) {
  test(`20 chatting in the cinema at ${name}: no bubble cut or over a tag, at most 8, tags apart`, async ({ browser, request }) => {
    test.setTimeout(120_000);
    await shareVideo(request, room.id);
    const crowd = await spawnBots(browser, room.id, SPECS);
    bots = crowd;
    expect(crowd.joined).toBe(SPECS.length);
    clients = await joinRoom(browser, { roomUrl: room.url, count: 1, nicknamePrefix: "me", contextOptions: () => options });
    const [me] = clients;
    if (me === undefined) throw new Error("no client");
    await waitPlaying([me]);
    // Everyone has walked to their place.
    await me.page.waitForTimeout(4000);
    // Each member says a line every 4 s, one every 200 ms, for 12 s; the bubble's first word is its speaker's tag.
    const talk = (async () => {
      for (let k = 0; k < 60; k++) {
        const i = k % SPECS.length;
        await crowd.say(i, `${SPECS[i]?.nickname ?? ""} says line ${String(k)}, how is it going over there`);
        await me.page.waitForTimeout(200);
      }
    })();
    const worst = await sample(me.page, 12_000);
    await talk;
    expect({ clipped: worst.clipped, overTag: worst.overTag, tagPairs: worst.tagPairs }).toEqual({ clipped: [], overTag: [], tagPairs: [] });
    expect(worst.shown).toBeLessThanOrEqual(8);
    // On the phone the zoomed window is all tags: a line that can't clear one shows in the chat log only.
    if (name === "1280×800") expect(worst.shown).toBeGreaterThan(0);
  });
}
