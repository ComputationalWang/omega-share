import { describe, expect, test } from "bun:test";
import { IFRAME_API_URL, LOAD_TIMEOUT_MS, createYouTubeLoader, type LoaderEnv } from "../src/player/youtube-loader";

interface Timer {
  fn: () => void;
  ms: number;
  cleared: boolean;
}

function env(win: Record<string, unknown> = {}) {
  const scripts: { src: string; onError: () => void }[] = [];
  const timers: Timer[] = [];
  const e: LoaderEnv<Timer> = {
    win,
    insertScript: (src, onError) => scripts.push({ src, onError }),
    setTimeout: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimeout: (t) => {
      t.cleared = true;
    },
  };
  return { e, win, scripts, timers };
}

const validYT = () => ({ Player: function Player() {} });

describe("youtube loader", () => {
  test("injects the iframe_api script once per page, however many callers", async () => {
    const { e, win, scripts } = env();
    const load = createYouTubeLoader(e);
    const a = load();
    const b = load();
    expect(a).toBe(b);
    expect(scripts.map((s) => s.src)).toEqual([IFRAME_API_URL]);
    expect(IFRAME_API_URL).toBe("https://www.youtube.com/iframe_api");
    win.YT = validYT();
    const ready = win.onYouTubeIframeAPIReady;
    expect(typeof ready).toBe("function");
    if (typeof ready === "function") ready();
    const r = await a;
    expect(r.ok).toBe(true);
    expect(scripts).toHaveLength(1);
  });

  test("resolves with the YT namespace and clears the timeout", async () => {
    const { e, win, timers } = env();
    const p = createYouTubeLoader(e)();
    const yt = validYT();
    win.YT = yt;
    const ready = win.onYouTubeIframeAPIReady;
    if (typeof ready === "function") ready();
    const r = await p;
    expect(r).toEqual({ ok: true, yt });
    expect(timers[0]?.cleared).toBe(true);
  });

  test("keeps a previously installed onYouTubeIframeAPIReady working", async () => {
    let called = 0;
    const { e, win } = env({ onYouTubeIframeAPIReady: () => called++ });
    const p = createYouTubeLoader(e)();
    win.YT = validYT();
    const ready = win.onYouTubeIframeAPIReady;
    if (typeof ready === "function") ready();
    await p;
    expect(called).toBe(1);
  });

  test("an API already on the page is used without injecting", async () => {
    const yt = validYT();
    const { e, scripts } = env({ YT: yt });
    const r = await createYouTubeLoader(e)();
    expect(r).toEqual({ ok: true, yt });
    expect(scripts).toEqual([]);
  });

  test("10 s without ready → video without sync", async () => {
    const { e, timers } = env();
    const p = createYouTubeLoader(e)();
    expect(timers[0]?.ms).toBe(10_000);
    expect(LOAD_TIMEOUT_MS).toBe(10_000);
    timers[0]?.fn();
    expect(await p).toEqual({ ok: false, reason: "timeout" });
  });

  test("a script error (CSP, offline) → video without sync", async () => {
    const { e, scripts, timers } = env();
    const p = createYouTubeLoader(e)();
    scripts[0]?.onError();
    expect(await p).toEqual({ ok: false, reason: "error" });
    expect(timers[0]?.cleared).toBe(true);
  });

  test("a malformed YT global is rejected at the boundary", async () => {
    const { e, win } = env();
    const p = createYouTubeLoader(e)();
    win.YT = { Player: "nope" };
    const ready = win.onYouTubeIframeAPIReady;
    if (typeof ready === "function") ready();
    expect(await p).toEqual({ ok: false, reason: "invalid" });
  });

  test("after a failure the page stays without sync (no second script)", async () => {
    const { e, scripts, timers } = env();
    const load = createYouTubeLoader(e);
    const first = load();
    timers[0]?.fn();
    await first;
    expect(await load()).toEqual({ ok: false, reason: "timeout" });
    expect(scripts).toHaveLength(1);
  });
});
