// OME-733 (M8 Q1): the floating chat bubbles (OME-730) from the outside, beyond e2e/bubbles.e2e.ts. A bubble hangs over
// its speaker and moves and fades, then is gone after about 5 s; the pool of 8 holds across speakers and no two visible
// bubbles overlap; reduced motion shows it at once without a rise or fade-in; the screen reader reads a line once (the
// chat log, never the aria-hidden layer); markup, RTL text and a max-length line are only ever text, bounded and
// non-overlapping. Each test has its own seeded room (support/test-rooms.ts, "m8-bubbles").
import type { Locator, Page } from "@playwright/test";
import { CHAT_MAX_LENGTH } from "@omega/shared";
import * as v from "valibot";
import { expect, test } from "./support/csp";
import { PENDING, available } from "./support/apps";
import { joinRoom, leaveAll, testRoom, type Client } from "./support/room";
import { site } from "./support/selectors";

test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);
test.setTimeout(60_000);

let clients: Client[] = [];
test.afterEach(async () => {
  await leaveAll(clients);
  clients = [];
});

async function say(page: Page, text: string): Promise<void> {
  await page.locator(site.chatInput).fill(text);
  await page.locator(site.chatInput).press("Enter");
}

const pair = (cs: readonly Client[]): [Client, Client] => {
  const [a, b] = cs;
  if (a === undefined || b === undefined) throw new Error("need 2 clients");
  return [a, b];
};

const RectSchema = v.object({ x: v.number(), y: v.number(), w: v.number(), h: v.number() });
type Rect = v.InferOutput<typeof RectSchema>;

/** An element's box in page px. */
async function rectOf(loc: Locator): Promise<Rect> {
  return v.parse(
    RectSchema,
    await loc.evaluate((e) => {
      const r = e.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    }),
  );
}

/** Joined avatars walk to their places first; a bubble resolves overlap once per walk end, so speak once they are at rest. */
async function atRest(page: Page): Promise<void> {
  let last = "";
  await expect
    .poll(
      async () => {
        const now = await page.evaluate(() =>
          [...document.querySelectorAll("[data-testid=room] .tag")].map((t) => `${t.textContent}@${String(Math.round(t.getBoundingClientRect().x))},${String(Math.round(t.getBoundingClientRect().y))}`).join(" "),
        );
        const still = now === last;
        last = now;
        await page.waitForTimeout(500);
        return still;
      },
      { timeout: 15_000, intervals: [0] },
    )
    .toBe(true);
}

// --- 1. float ------------------------------------------------------------------------------------------------------

test("a bubble hangs over its speaker's name tag, moves and fades while it lives, and is gone after about 5 s", async ({ browser }) => {
  clients = await joinRoom(browser, { roomUrl: testRoom("m8-bubbles", "float").url, count: 2, nicknamePrefix: "mf" });
  const [a, b] = pair(clients);
  await atRest(a.page);
  await say(b.page, "over my head");
  const bubble = a.page.locator(".ui-float").filter({ hasText: "over my head" });
  await expect(bubble).toBeVisible();
  const born = Date.now();

  // Over the head: the box shares the speaker's horizontal span (tags are centred on the head) and sits above the tag.
  const tag = a.page.locator(`${site.room} .tag`).filter({ hasText: b.nickname });
  await expect(tag).toBeVisible();
  const t = await rectOf(tag);
  await expect.poll(async () => (await rectOf(bubble)).h).toBeGreaterThan(0);
  const r = await rectOf(bubble);
  expect(r.x).toBeLessThan(t.x + t.w);
  expect(r.x + r.w).toBeGreaterThan(t.x);
  expect(r.y + r.h).toBeLessThanOrEqual(t.y + 1);

  // Moves and fades: with no reduced-motion preference the computed opacity and the rise change over its life. Both are
  // on the bubble's bare wrapper (OME-802, ADR 0040: stepped on one clock, the bubble itself never restyled by a step).
  expect(await a.page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(false);
  const Sample = v.object({ opacity: v.string(), translate: v.string() });
  const samples = new Set<string>();
  const opacities = new Set<string>();
  const translates = new Set<string>();
  for (let i = 0; i < 12 && Date.now() - born < 4600; i++) {
    const s = v.parse(
      Sample,
      await bubble.evaluate((e) => {
        const cs = getComputedStyle(e.parentElement ?? e);
        return { opacity: cs.opacity, translate: cs.translate };
      }),
    );
    samples.add(JSON.stringify(s));
    opacities.add(s.opacity);
    translates.add(s.translate);
    await a.page.waitForTimeout(350);
  }
  expect(opacities.size, `opacity never changed: ${[...samples].join(" ")}`).toBeGreaterThan(1);
  expect(translates.size, `no rise: ${[...samples].join(" ")}`).toBeGreaterThan(1);

  await expect(bubble).toBeHidden({ timeout: 4000 });
  const lived = Date.now() - born;
  expect(lived).toBeGreaterThan(3500);
  expect(lived).toBeLessThan(8000);
  await expect(a.page.locator(`${site.room} .float-slot:not([hidden])`)).toHaveCount(0);
  await expect(a.page.locator(`${site.room} .float-slot`)).toHaveCount(8);
});

// --- 2. pool cap across speakers -----------------------------------------------------------------------------------

const PoolSchema = v.object({ maxLive: v.number(), maxNodes: v.number(), minNodes: v.number(), overlaps: v.array(v.string()), frames: v.number(), events: v.array(v.string()) });

/** In the page: for `ms`, every frame, count the shown nodes and check the live (not leaving) boxes pairwise. */
function watchPool(ms: number): Promise<unknown> {
  return new Promise((resolve) => {
    const start = performance.now();
    let maxLive = 0;
    let maxNodes = 0;
    let minNodes = Infinity;
    let frames = 0;
    const overlaps: string[] = [];
    // An older bubble pushed up by a newer one slides clear in 160 ms (4 steps); only an overlap that outlasts that counts.
    const since = new Map<string, number>();
    // Each slot's state changes (shown/hidden, classes, text), for the failure message.
    const events: string[] = [];
    const lastState = new Map<HTMLElement, string>();
    const tick = (): void => {
      frames++;
      const layer = document.querySelector("[data-testid=room] .bubbles");
      const nodes = layer === null ? [] : [...layer.querySelectorAll<HTMLElement>(".float-slot")];
      minNodes = Math.min(minNodes, nodes.length);
      maxNodes = Math.max(maxNodes, nodes.length);
      for (const n of nodes) {
        const f = n.querySelector<HTMLElement>(".ui-float");
        const st = `${n.hidden ? "hidden" : "shown"} ${f?.className ?? ""} "${f?.textContent ?? ""}"`;
        if (lastState.get(n) !== st) events.push(`${String(Math.round(performance.now() - start))} ms ${st}`);
        lastState.set(n, st);
      }
      const live = nodes.filter((n) => !n.hidden).map((n) => n.querySelector<HTMLElement>(".ui-float")).filter((p): p is HTMLElement => p !== null && !p.classList.contains("is-leaving"));
      maxLive = Math.max(maxLive, live.length);
      const rs = live.map((p) => ({ t: p.textContent, r: p.getBoundingClientRect() }));
      const now = performance.now();
      const open = new Set<string>();
      for (let i = 0; i < rs.length; i++) {
        for (let j = i + 1; j < rs.length; j++) {
          const p = rs[i];
          const q = rs[j];
          if (p === undefined || q === undefined) continue;
          const ox = Math.min(p.r.right, q.r.right) - Math.max(p.r.left, q.r.left);
          const oy = Math.min(p.r.bottom, q.r.bottom) - Math.max(p.r.top, q.r.top);
          if (ox <= 1 || oy <= 1) continue;
          const key = `${p.t} x ${q.t}`;
          open.add(key);
          const first = since.get(key) ?? now;
          since.set(key, first);
          if (now - first > 300) overlaps.push(`${key} (${String(Math.round(ox))}x${String(Math.round(oy))} for ${String(Math.round(now - first))} ms)`);
        }
      }
      for (const key of since.keys()) if (!open.has(key)) since.delete(key);
      if (performance.now() - start < ms) requestAnimationFrame(tick);
      else resolve({ maxLive, maxNodes, minNodes, overlaps: [...new Set(overlaps)], frames, events });
    };
    requestAnimationFrame(tick);
  });
}

test("five speakers, ten lines at once: never more than 8 bubbles shown, the layer holds 8 nodes throughout", async ({ browser }) => {
  clients = await joinRoom(browser, { roomUrl: testRoom("m8-bubbles", "cap").url, count: 5, nicknamePrefix: "mc" });
  const [a] = clients;
  if (a === undefined) throw new Error("no client");
  for (const c of clients) await atRest(c.page);
  // Long enough to outlast slow sends (a cold dev server, five pages typing in turn); bubbles leaving after 5 s only
  // lower the count, so a longer watch can't hide a pool over 8.
  const watching = a.page.evaluate(watchPool, 10_000);
  const sendStart = Date.now();
  await Promise.all(
    clients.map(async (c, i) => {
      await say(c.page, `speaker ${String(i + 1)} line one`);
      await say(c.page, `speaker ${String(i + 1)} line two`);
    }),
  );
  const sendMs = Date.now() - sendStart;
  await expect(a.page.locator(site.chatLogLine).filter({ hasText: /speaker [1-5] line (one|two)/ })).toHaveCount(10); // all said, none dropped
  const pool = v.parse(PoolSchema, await watching);
  expect(pool.frames).toBeGreaterThan(10);
  expect(pool.maxLive).toBeLessThanOrEqual(8);
  // The pool really filled: 10 lines were said, only 8 fit.
  expect(pool.maxLive, `peak live bubbles (the sends took ${String(sendMs)} ms):\n${pool.events.join("\n")}`).toBeGreaterThanOrEqual(6);
  expect(pool.minNodes).toBe(8);
  expect(pool.maxNodes).toBe(8);
});

// OME-809: two lines from one speaker that arrive before the watcher next renders both float. Here the watcher renders
// late (a slow frame) while both lines arrive; on a fast box the same happens when two lines land in one 16 ms frame.
test("two lines from one speaker that arrive inside one render both float (2 per speaker)", async ({ browser }) => {
  clients = await joinRoom(browser, { roomUrl: testRoom("m8-bubbles", "batch").url, count: 2, nicknamePrefix: "mb" });
  const [speaker, watcher] = pair(clients);
  for (const c of clients) await atRest(c.page);
  // A slow frame on the watcher: its next renders come 300 ms late, as on a busy phone. Both lines then reach it
  // before it renders (they also leave the speaker in one task, back to back).
  await watcher.page.evaluate(() => {
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => {
      setTimeout(() => raf(cb), 300);
      return 0;
    };
    setTimeout(() => {
      window.requestAnimationFrame = raf;
    }, 2000);
  });
  await speaker.page.evaluate((sel) => {
    const input = document.querySelector<HTMLInputElement>(sel);
    if (input === null) throw new Error("no chat input");
    for (const text of ["batch line one", "batch line two"]) {
      input.value = text;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.form?.requestSubmit();
    }
  }, site.chatInput);
  await expect(watcher.page.locator(site.chatLogLine).filter({ hasText: /batch line (one|two)/ })).toHaveCount(2);
  const shown = watcher.page.locator(`${site.room} .float-slot:not([hidden]) .ui-float`);
  await expect(shown.filter({ hasText: "batch line two" })).toHaveCount(1);
  await expect(shown.filter({ hasText: "batch line one" })).toHaveCount(1, { timeout: 2000 });
});

// OME-791: a stacked bubble gains its speaker's name after it was first measured, so it is measured and centred again
// before the overlap maths uses its width (it once sat ~16 stage px off its head and overlapped its neighbour on a row).
test("five speakers, ten lines: no two visible bubbles overlap (once the 160 ms slide clear is done)", async ({ browser }) => {
  clients = await joinRoom(browser, { roomUrl: testRoom("m8-bubbles", "overlap").url, count: 5, nicknamePrefix: "mo" });
  const [a] = clients;
  if (a === undefined) throw new Error("no client");
  for (const c of clients) await atRest(c.page);
  const watching = a.page.evaluate(watchPool, 5000);
  for (const l of ["one", "two"]) {
    for (const [i, c] of clients.entries()) {
      await say(c.page, `speaker ${String(i + 1)} line ${l}`);
      await a.page.waitForTimeout(250);
    }
  }
  const pool = v.parse(PoolSchema, await watching);
  expect(pool.frames).toBeGreaterThan(10);
  expect(pool.overlaps).toEqual([]);
});

// --- 3. reduced motion ---------------------------------------------------------------------------------------------

test("reduced motion: a bubble shows at once and holds still (no fade-in, no rise), then still goes", async ({ browser }) => {
  clients = await joinRoom(browser, {
    roomUrl: testRoom("m8-bubbles", "reduced").url,
    count: 2,
    nicknamePrefix: "mr",
    contextOptions: () => ({ reducedMotion: "reduce" }),
  });
  const [a, b] = pair(clients);
  expect(await a.page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
  await say(b.page, "still bubble");
  const bubble = a.page.locator(".ui-float").filter({ hasText: "still bubble" });
  await expect(bubble).toBeVisible();
  const born = Date.now();
  const Seen = v.object({ opacity: v.array(v.string()), translate: v.array(v.string()), transform: v.array(v.string()), animations: v.array(v.string()), n: v.number() });
  const seen = v.parse(
    Seen,
    await bubble.evaluate(
      (e) =>
        new Promise<unknown>((resolve) => {
          const start = performance.now();
          const opacity = new Set<string>();
          const translate = new Set<string>();
          const transform = new Set<string>();
          const animations = new Set<string>();
          let n = 0;
          // The bubble and its bare motion wrapper (OME-802): nothing may move either.
          const motion = e.parentElement ?? e;
          const tick = (): void => {
            const cs = getComputedStyle(motion);
            opacity.add(cs.opacity);
            translate.add(cs.translate);
            transform.add(cs.transform);
            for (const an of [...e.getAnimations(), ...motion.getAnimations()]) if (an instanceof CSSAnimation || an instanceof CSSTransition) animations.add(an instanceof CSSAnimation ? an.animationName : an.transitionProperty);
            n++;
            if (performance.now() - start < 1000) requestAnimationFrame(tick);
            else resolve({ opacity: [...opacity], translate: [...translate], transform: [...transform], animations: [...animations], n });
          };
          requestAnimationFrame(tick);
        }),
    ),
  );
  expect(seen.n).toBeGreaterThan(10);
  expect(seen.opacity, "opaque from the first frame, no fade-in").toEqual(["1"]);
  expect(seen.translate, "no rise").toHaveLength(1);
  expect(seen.transform).toHaveLength(1);
  expect(seen.animations.filter((n) => n !== "ui-float-life-reduced"), "no motion but the one end fade").toEqual([]);
  await expect(bubble).toBeHidden({ timeout: 7000 });
  expect(Date.now() - born).toBeGreaterThan(3500);
});

// --- 4. screen reader ----------------------------------------------------------------------------------------------

const AxNode = v.object({
  nodeId: v.string(),
  parentId: v.optional(v.string()),
  ignored: v.optional(v.boolean()),
  role: v.optional(v.object({ value: v.unknown() })),
  name: v.optional(v.object({ value: v.unknown() })),
});
type AxNodeT = v.InferOutput<typeof AxNode>;
const AxTree = v.object({ nodes: v.array(AxNode) });

test("a line is in the accessibility tree once, in the chat log; the bubble layer is aria-hidden", async ({ browser }) => {
  clients = await joinRoom(browser, { roomUrl: testRoom("m8-bubbles", "aria").url, count: 2, nicknamePrefix: "ma" });
  const [a, b] = pair(clients);
  const text = "heard exactly once";
  await say(b.page, text);
  await expect(a.page.locator(".ui-float").filter({ hasText: text })).toBeVisible();
  await expect(a.page.locator(site.chatLogLine).filter({ hasText: text })).toHaveCount(1);
  await expect(a.page.locator(`${site.room} .bubbles`)).toHaveAttribute("aria-hidden", "true");

  const cdp = await a.context.newCDPSession(a.page);
  await cdp.send("Accessibility.enable");
  const tree = v.parse(AxTree, await cdp.send("Accessibility.getFullAXTree"));
  const byId = new Map(tree.nodes.map((n) => [n.nodeId, n]));
  const roleOf = (n: AxNodeT): string => (typeof n.role?.value === "string" ? n.role.value : "");
  const hits = tree.nodes.filter((n) => n.ignored !== true && roleOf(n) === "StaticText" && typeof n.name?.value === "string" && n.name.value.includes(text));
  expect(hits.map((n) => `${roleOf(n)}:${String(n.name?.value)}`)).toHaveLength(1);
  const [hit] = hits;
  if (hit === undefined) throw new Error("the line is not in the AX tree at all");
  const chain: string[] = [];
  for (let n: AxNodeT | undefined = hit; n !== undefined; n = n.parentId === undefined ? undefined : byId.get(n.parentId)) chain.push(roleOf(n));
  expect(chain, "the one node sits under the role=log").toContain("log");
});

// --- 5. abuse / safety ---------------------------------------------------------------------------------------------

const MARKUP = "<img src=x onerror=window.__pwned=1><b>bold</b>";
const RTL = "مرحبا بالعالم abc / שלום עולם abc";
const LONG_WORDS = Array.from({ length: Math.ceil(CHAT_MAX_LENGTH / 6) }, () => "words").join(" ").slice(0, CHAT_MAX_LENGTH);
const LONG_RUN = "W".repeat(CHAT_MAX_LENGTH);

const BubblesState = v.object({
  bubbles: v.array(v.object({ text: v.string(), kids: v.number(), x: v.number(), y: v.number(), w: v.number(), h: v.number() })),
  stage: RectSchema,
  pwned: v.boolean(),
});

test("markup, RTL and max-length lines are text only: no elements inside, bounded, inside the room, not overlapping", async ({ browser }) => {
  expect(LONG_WORDS).toHaveLength(CHAT_MAX_LENGTH);
  clients = await joinRoom(browser, { roomUrl: testRoom("m8-bubbles", "abuse").url, count: 4, nicknamePrefix: "mx" });
  const [watcher, s1, s2, s3] = clients;
  if (watcher === undefined || s1 === undefined || s2 === undefined || s3 === undefined) throw new Error("need 4 clients");
  for (const c of clients) await atRest(c.page);
  // A bidi override in chat is refused by the wire contract: no bubble, no line; a plain line right after still lands.
  // Paced: the server rate-limits chat in bursts and a dropped line would only show as a missing bubble.
  for (const [c, text] of [
    [s3, "مرحبا بالعالم \u202eabc"],
    [s3, "after the refused one"],
    [s1, MARKUP],
    [s2, LONG_WORDS],
    [s1, RTL],
    [s2, LONG_RUN],
  ] as const) {
    await say(c.page, text);
    await watcher.page.waitForTimeout(300);
  }
  const sent = [MARKUP, RTL, LONG_WORDS, LONG_RUN, "after the refused one"];
  await expect(watcher.page.locator(`${site.room} .float-slot:not([hidden]) .say > span`)).toHaveCount(sent.length, { timeout: 5000 });

  await watcher.page.waitForTimeout(600); // the older bubbles' 160 ms slide clear is done
  const state = v.parse(
    BubblesState,
    await watcher.page.evaluate(() => {
      const stage = document.querySelector("[data-testid=room]")?.getBoundingClientRect();
      const bubbles = [...document.querySelectorAll<HTMLElement>("[data-testid=room] .float-slot:not([hidden]) .ui-float")].map((p) => {
        const t = p.querySelector(".say > span");
        const r = p.getBoundingClientRect();
        return { text: t?.textContent ?? "", kids: t?.children.length ?? -1, x: r.x, y: r.y, w: r.width, h: r.height };
      });
      return { bubbles, stage: { x: stage?.x ?? 0, y: stage?.y ?? 0, w: stage?.width ?? 0, h: stage?.height ?? 0 }, pwned: Reflect.has(window, "__pwned") };
    }),
  );
  expect(state.pwned).toBe(false);
  expect(state.bubbles.map((b) => b.text).sort()).toEqual([...sent].sort());
  for (const b of state.bubbles) {
    expect(b.kids, `${b.text.slice(0, 20)} has child elements`).toBe(0);
    expect(b.w).toBeGreaterThan(0);
    expect(b.w, "bubble width bounded").toBeLessThanOrEqual(state.stage.w * 0.75);
    expect(b.x).toBeGreaterThanOrEqual(state.stage.x - 1);
    expect(b.x + b.w).toBeLessThanOrEqual(state.stage.x + state.stage.w + 1);
    expect(b.y + b.h).toBeLessThanOrEqual(state.stage.y + state.stage.h + 1);
  }
  const rs = state.bubbles;
  for (let i = 0; i < rs.length; i++) {
    for (let j = i + 1; j < rs.length; j++) {
      const p = rs[i];
      const q = rs[j];
      if (p === undefined || q === undefined) continue;
      const ox = Math.min(p.x + p.w, q.x + q.w) - Math.max(p.x, q.x);
      const oy = Math.min(p.y + p.h, q.y + q.h) - Math.max(p.y, q.y);
      expect(ox > 1 && oy > 1, `${p.text.slice(0, 12)} overlaps ${q.text.slice(0, 12)}`).toBe(false);
    }
  }
  // The chat log (the accessible record) carries the markup as text too: no element inside it but the nickname's <b>.
  await expect(watcher.page.locator(`${site.chatLog} img`)).toHaveCount(0);
  await expect(watcher.page.locator(site.chatLogLine).filter({ hasText: MARKUP })).toHaveCount(1);
});
