import { describe, expect, test } from "bun:test";
import { VIMEO_LOAD_TIMEOUT_MS, VIMEO_SDK_URL, createVimeoLoader, type VimeoLoaderEnv } from "../src/player/vimeo-loader";

interface Timer {
  fn: () => void;
  ms: number;
  cleared: boolean;
}

function env(initial?: unknown) {
  const g: { Vimeo: unknown } = { Vimeo: initial };
  const scripts: { src: string; onLoad: () => void; onError: () => void }[] = [];
  const timers: Timer[] = [];
  const e: VimeoLoaderEnv<Timer> = {
    readGlobal: () => g.Vimeo,
    insertScript: (src, onLoad, onError) => scripts.push({ src, onLoad, onError }),
    setTimeout: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimeout: (t) => {
      t.cleared = true;
    },
  };
  return { e, g, scripts, timers };
}

const validVimeo = (): unknown => ({ Player: () => undefined });

describe("vimeo loader", () => {
  test("injects the exact served SDK file once per page, however many callers", async () => {
    const { e, g, scripts, timers } = env();
    const load = createVimeoLoader(e);
    const a = load();
    const b = load();
    expect(scripts.map((s) => s.src)).toEqual(["https://player.vimeo.com/api/player.js"]);
    expect(VIMEO_SDK_URL).toBe("https://player.vimeo.com/api/player.js");
    g.Vimeo = validVimeo();
    scripts[0]?.onLoad();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.ok).toBe(true);
    expect(rb).toBe(ra);
    expect(timers[0]?.cleared).toBe(true);
    expect(await load()).toBe(ra);
    expect(scripts).toHaveLength(1);
  });

  test("an SDK already on the page is used without injecting", async () => {
    const { e, scripts } = env(validVimeo());
    expect((await createVimeoLoader(e)()).ok).toBe(true);
    expect(scripts).toHaveLength(0);
  });

  test("script error → error; loaded but no usable Vimeo.Player → invalid", async () => {
    const a = env();
    const pa = createVimeoLoader(a.e)();
    a.scripts[0]?.onError();
    expect(await pa).toEqual({ ok: false, reason: "error" });

    const b = env();
    const pb = createVimeoLoader(b.e)();
    b.g.Vimeo = { Player: "nope" };
    b.scripts[0]?.onLoad();
    expect(await pb).toEqual({ ok: false, reason: "invalid" });
  });

  test("never loads → timeout after the load timeout; a late onload changes nothing", async () => {
    const { e, g, scripts, timers } = env();
    const p = createVimeoLoader(e)();
    expect(timers[0]?.ms).toBe(VIMEO_LOAD_TIMEOUT_MS);
    timers[0]?.fn();
    expect(await p).toEqual({ ok: false, reason: "timeout" });
    g.Vimeo = validVimeo();
    scripts[0]?.onLoad();
    expect(await p).toEqual({ ok: false, reason: "timeout" });
  });
});
