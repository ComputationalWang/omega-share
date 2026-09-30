import { describe, expect, test } from "bun:test";
import { TWITCH_LOAD_TIMEOUT_MS, TWITCH_SDK_URL, createTwitchLoader, type TwitchLoaderEnv } from "../src/player/twitch-loader";

interface Timer {
  fn: () => void;
  ms: number;
  cleared: boolean;
}

function env(initial: unknown = undefined) {
  const g = { Twitch: initial };
  const scripts: { src: string; onLoad: () => void; onError: () => void }[] = [];
  const timers: Timer[] = [];
  const e: TwitchLoaderEnv<Timer> = {
    readGlobal: () => g.Twitch,
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

const validTwitch = (): unknown => ({ Player: class {} });

describe("twitch loader", () => {
  test("injects the served v1.js once per page, however many callers", async () => {
    const { e, g, scripts } = env();
    const load = createTwitchLoader(e);
    const a = load();
    const b = load();
    expect(a).toBe(b);
    expect(TWITCH_SDK_URL).toBe("https://player.twitch.tv/js/embed/v1.js");
    expect(scripts.map((s) => s.src)).toEqual([TWITCH_SDK_URL]);
    g.Twitch = validTwitch();
    scripts[0]?.onLoad();
    const r = await a;
    expect(r.ok).toBe(true);
    expect(scripts).toHaveLength(1);
  });

  test("resolves with window.Twitch once the script ran, and clears the timeout", async () => {
    const { e, g, scripts, timers } = env();
    const p = createTwitchLoader(e)();
    const tw = validTwitch();
    g.Twitch = tw;
    scripts[0]?.onLoad();
    const r = await p;
    const got: unknown = r.ok ? r.twitch : null;
    expect(got).toBe(tw);
    expect(timers.map((t) => [t.ms, t.cleared])).toEqual([[TWITCH_LOAD_TIMEOUT_MS, true]]);
  });

  test("a loaded script that didn't leave a usable Twitch.Player → invalid", async () => {
    const { e, g, scripts } = env();
    const p = createTwitchLoader(e)();
    g.Twitch = { Player: "nope" };
    scripts[0]?.onLoad();
    expect(await p).toEqual({ ok: false, reason: "invalid" });
  });

  test("script error → error; no answer within 10 s → timeout", async () => {
    const a = env();
    const pa = createTwitchLoader(a.e)();
    a.scripts[0]?.onError();
    expect(await pa).toEqual({ ok: false, reason: "error" });

    const b = env();
    const pb = createTwitchLoader(b.e)();
    expect(TWITCH_LOAD_TIMEOUT_MS).toBe(10_000);
    b.timers[0]?.fn();
    expect(await pb).toEqual({ ok: false, reason: "timeout" });
    // A late load after the timeout changes nothing.
    b.g.Twitch = validTwitch();
    b.scripts[0]?.onLoad();
    expect(await pb).toEqual({ ok: false, reason: "timeout" });
  });

  test("an SDK already on the page is used without another script", async () => {
    const { e, scripts } = env(validTwitch());
    const r = await createTwitchLoader(e)();
    expect(r.ok).toBe(true);
    expect(scripts).toEqual([]);
  });
});
