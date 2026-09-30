// Self-tests for the fake Vimeo Player SDK (OME-121). Real time, no fake clocks: the fake is performance.now()-driven.
import { expect, test } from "bun:test";
import { installFakeVimeo } from "../fixtures/fake-vimeo-player";
import type { FakeVimeoHooks, FakeVimeoHost, VimeoElementLike, VimeoPlayer, VimeoPlayerCtor } from "../fixtures/fake-vimeo-player";

const SRC = "https://player.vimeo.com/video/76979871?h=abc&dnt=1";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The `.name` a promise rejects with, or "resolved". */
async function rejectName(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return e instanceof Error ? e.name : "not-an-error";
  }
  return "resolved";
}

function el(src: string | null, tagName = "IFRAME"): VimeoElementLike {
  return { nodeType: 1, tagName, getAttribute: (n) => (n === "src" ? src : null) };
}

interface Rig {
  Player: VimeoPlayerCtor;
  hooks: FakeVimeoHooks;
  player: VimeoPlayer;
  seen: string[];
}

function install(): FakeVimeoHost {
  const host: FakeVimeoHost = { performance, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => { clearTimeout(h as ReturnType<typeof setTimeout>); } };
  installFakeVimeo(host);
  return host;
}

function parts(host: FakeVimeoHost): { Player: VimeoPlayerCtor; hooks: FakeVimeoHooks } {
  const Player = host.Vimeo?.Player;
  const hooks = host.__fakeVimeo;
  if (!Player || !hooks) throw new Error("fake did not install Vimeo and __fakeVimeo");
  return { Player, hooks };
}

/** Ready player with every event type recorded (names only) into `seen`. */
async function rig(pre?: (h: FakeVimeoHooks) => void, src = SRC): Promise<Rig> {
  const { Player, hooks } = parts(install());
  pre?.(hooks);
  const player = new Player(el(src));
  const seen: string[] = [];
  for (const t of ["play", "playing", "pause", "ended", "seeking", "seeked", "bufferstart", "bufferend", "playbackratechange"]) {
    player.on(t, () => seen.push(t));
  }
  await player.ready();
  seen.length = 0;
  return { Player, hooks, player, seen };
}

async function slope(hooks: FakeVimeoHooks, ms: number): Promise<number> {
  const t0 = performance.now();
  const m0 = hooks.currentTime;
  await sleep(ms);
  return (hooks.currentTime - m0) / ((performance.now() - t0) / 1000);
}

test("install defines Vimeo.Player and __fakeVimeo, and is idempotent", () => {
  const host = install();
  const first = host.Vimeo;
  expect(typeof first?.Player).toBe("function");
  expect(typeof host.__fakeVimeo?.buffering).toBe("function");
  installFakeVimeo(host);
  expect(host.Vimeo).toBe(first);
});

test("constructor rejects bad elements and sources, accepts a Vimeo embed and records src and query", () => {
  const host = install();
  const { Player } = parts(host);
  expect(() => new Player({ nodeType: 3, tagName: "IFRAME", getAttribute: () => null })).toThrow(TypeError);
  expect(() => new Player("missing")).toThrow("You must pass either a valid element or a valid id.");
  expect(() => new Player(el(SRC, "DIV"))).toThrow();
  expect(() => new Player(el("https://example.com/video/123"))).toThrow();
  expect(() => new Player(el("https://player.vimeo.com/video/abc"))).toThrow();
  expect(() => new Player(el("http://player.vimeo.com/video/123"))).toThrow();
  expect(() => new Player(el(null))).toThrow();
  const p = new Player(el(SRC));
  expect(typeof p.play).toBe("function");
  expect(host.__fakeVimeo?.src).toBe(SRC);
  expect(host.__fakeVimeo?.query).toEqual({ h: "abc", dnt: "1" });
  expect(host.__fakeVimeo?.player).toBe(p);
});

test("string ids resolve through document.getElementById; same element gives the same instance", () => {
  const frame = el(SRC);
  const host: FakeVimeoHost = { performance, setTimeout: (fn, ms) => setTimeout(fn, ms), document: { getElementById: (id) => (id === "v" ? frame : null) } };
  installFakeVimeo(host);
  const { Player } = parts(host);
  expect(new Player("v")).toBe(new Player(frame));
  expect(new Player(el(SRC))).not.toBe(new Player(frame));
});

test("ready resolves asynchronously after readyDelayMs and emits loaded", async () => {
  const { Player, hooks } = parts(install());
  hooks.configure({ readyDelayMs: 60 });
  const p = new Player(el(SRC));
  let loaded: unknown = null;
  p.on("loaded", (d) => { loaded = d; });
  const t0 = performance.now();
  let done = false;
  const r = p.ready().then(() => { done = true; });
  expect(done).toBe(false);
  await r;
  expect(performance.now() - t0).toBeGreaterThanOrEqual(55);
  expect(loaded).toEqual({ id: 76979871 });
});

test("privacy() and password() reject ready with the right name, also for calls made before ready, and emit error", async () => {
  for (const [hook, name] of [["privacy", "PrivacyError"], ["password", "PasswordError"]] as const) {
    const { Player, hooks } = parts(install());
    hooks[hook]();
    const p = new Player(el(SRC));
    const errors: unknown[] = [];
    p.on("error", (d) => errors.push(d));
    const early = rejectName(p.play());
    expect(await rejectName(p.ready())).toBe(name);
    expect(await early).toBe(name);
    expect(await rejectName(p.getCurrentTime())).toBe(name);
    expect(errors[0]).toMatchObject({ name, method: "ready" });
  }
});

test("privacy() set while a player is not yet ready applies to it", async () => {
  const { Player, hooks } = parts(install());
  const p = new Player(el(SRC));
  hooks.privacy();
  expect(await rejectName(p.ready())).toBe("PrivacyError");
});

test("every method returns a Promise and defaults are sane", async () => {
  const { player } = await rig();
  const calls = [player.ready(), player.play(), player.pause(), player.getPaused(), player.getEnded(), player.getCurrentTime(), player.getDuration(), player.getBuffered(), player.getPlaybackRate(), player.getVolume(), player.getMuted(), player.getVideoId(), player.setVolume(0.5), player.setMuted(false), player.setCurrentTime(1)];
  for (const c of calls) expect(c).toBeInstanceOf(Promise);
  await Promise.all(calls);
  expect(await player.getDuration()).toBeCloseTo(634.5, 3);
  expect(await player.getVideoId()).toBe(76979871);
  expect(await player.getPlaybackRate()).toBe(1);
  expect(await player.getVolume()).toBe(0.5);
  expect(await player.getMuted()).toBe(false);
});

test("media clock runs at 1x while playing, frozen while paused", async () => {
  const { player, hooks } = await rig();
  await player.play();
  const s = await slope(hooks, 1000);
  expect(s).toBeGreaterThan(0.98);
  expect(s).toBeLessThan(1.02);
  await player.pause();
  const t = hooks.currentTime;
  await sleep(150);
  expect(hooks.currentTime).toBe(t);
  expect(await player.getCurrentTime()).toBe(t);
  expect(hooks.paused).toBe(true);
});

test("timeupdate fires about every 250 ms while playing with seconds, percent, duration", async () => {
  const { player } = await rig();
  const ts: number[] = [];
  const got: { seconds: number; percent: number; duration: number }[] = [];
  player.on("timeupdate", (d) => {
    ts.push(performance.now());
    got.push(d as { seconds: number; percent: number; duration: number });
  });
  await player.play();
  await sleep(1100);
  await player.pause();
  const n = ts.length;
  expect(n).toBeGreaterThanOrEqual(3);
  expect(n).toBeLessThanOrEqual(6);
  const gap = ((ts[1] ?? 0) - (ts[0] ?? 0));
  expect(gap).toBeGreaterThan(225);
  expect(gap).toBeLessThan(290);
  const l = got[got.length - 1];
  expect(l?.duration).toBeCloseTo(634.5, 3);
  expect(l?.percent).toBeCloseTo((l?.seconds ?? -1) / 634.5, 6);
  await sleep(300);
  expect(ts.length).toBeLessThanOrEqual(n + 1);
});

test("play emits play then playing; pause emits pause; payload carries seconds/percent/duration", async () => {
  const { player, seen } = await rig();
  const payloads: unknown[] = [];
  player.on("play", (d) => payloads.push(d));
  await player.play();
  await sleep(20);
  await player.pause();
  expect(seen).toEqual(["play", "playing", "pause"]);
  expect(payloads[0]).toMatchObject({ duration: 634.5 });
  expect((payloads[0] as { seconds: number }).seconds).toBeLessThan(0.05);
});

test("setCurrentTime emits seeking then seeked, resolves to the seconds, keeps play state, rejects RangeError out of range", async () => {
  const { player, hooks, seen } = await rig();
  expect(await player.setCurrentTime(42)).toBe(42);
  await sleep(10);
  expect(seen).toEqual(["seeking", "seeked"]);
  expect(hooks.paused).toBe(true);
  expect(hooks.currentTime).toBe(42);
  await player.play();
  await player.setCurrentTime(100);
  expect(hooks.paused).toBe(false);
  expect(hooks.currentTime).toBeGreaterThanOrEqual(100);
  expect(await rejectName(player.setCurrentTime(-1))).toBe("RangeError");
  expect(await rejectName(player.setCurrentTime(9999))).toBe("RangeError");
});

test("setPlaybackRate rejects Error by default and RangeError outside [0.5, 2]", async () => {
  const { player, hooks } = await rig();
  expect(await rejectName(player.setPlaybackRate(1.25))).toBe("Error");
  expect(hooks.calls.some((c) => c.name === "setPlaybackRate" && c.args[0] === 1.25)).toBe(true);
  hooks.rateAllowed(true);
  expect(await rejectName(player.setPlaybackRate(3))).toBe("RangeError");
  expect(await rejectName(player.setPlaybackRate(0.25))).toBe("RangeError");
});

test("rateAllowed: the clock runs at 1.25x", async () => {
  const { player, hooks, seen } = await rig((h) => { h.rateAllowed(true); });
  expect(await player.setPlaybackRate(1.25)).toBe(1.25);
  expect(await player.getPlaybackRate()).toBe(1.25);
  expect(seen).toEqual(["playbackratechange"]);
  await player.play();
  const s = await slope(hooks, 1000);
  expect(s).toBeGreaterThan(1.225);
  expect(s).toBeLessThan(1.275);
  expect(hooks.rate).toBe(1.25);
});

test("rateIgnored: echoes 1.25 and emits the event, but the clock stays at 1x", async () => {
  const { player, hooks, seen } = await rig((h) => { h.rateAllowed(true); h.rateIgnored(true); });
  expect(await player.setPlaybackRate(1.25)).toBe(1.25);
  expect(await player.getPlaybackRate()).toBe(1.25);
  expect(seen).toEqual(["playbackratechange"]);
  await player.play();
  const s = await slope(hooks, 1000);
  expect(s).toBeGreaterThan(0.98);
  expect(s).toBeLessThan(1.02);
  expect(hooks.rate).toBe(1);
});

test("buffering(ms) emits bufferstart/bufferend and freezes the clock, then resumes", async () => {
  const { player, hooks, seen } = await rig();
  await player.play();
  await sleep(100);
  seen.length = 0;
  hooks.buffering(300);
  const t = hooks.currentTime;
  await sleep(200);
  expect(hooks.currentTime).toBe(t);
  expect(seen).toEqual(["bufferstart"]);
  await sleep(200);
  expect(seen).toEqual(["bufferstart", "bufferend"]);
  await sleep(100);
  expect(hooks.currentTime).toBeGreaterThan(t + 0.05);
  expect(hooks.paused).toBe(false);
});

test("seekLatency(ms): seeking, bufferstart, wait, bufferend, seeked; play state unchanged", async () => {
  const { player, hooks, seen } = await rig((h) => { h.seekLatency(200); });
  await player.play();
  seen.length = 0;
  const p = player.setCurrentTime(50);
  await sleep(100);
  expect(seen).toEqual(["seeking", "bufferstart"]);
  await p;
  expect(seen).toEqual(["seeking", "bufferstart", "bufferend", "seeked"]);
  expect(hooks.paused).toBe(false);
  expect(hooks.currentTime).toBeGreaterThanOrEqual(50);
});

test("autoplayBlocked: unmuted play rejects NotAllowedError, muted works, allowAutoplay lifts it", async () => {
  const { player, hooks } = await rig((h) => { h.autoplayBlocked(); });
  expect(await rejectName(player.play())).toBe("NotAllowedError");
  expect(hooks.paused).toBe(true);
  await player.setMuted(true);
  await player.play();
  expect(hooks.paused).toBe(false);
  await player.pause();
  await player.setMuted(false);
  expect(await rejectName(player.play())).toBe("NotAllowedError");
  hooks.allowAutoplay();
  await player.play();
  expect(hooks.paused).toBe(false);
});

test("autoplayBlocked while playing unmuted pauses and emits pause", async () => {
  const { player, hooks, seen } = await rig();
  await player.play();
  seen.length = 0;
  hooks.autoplayBlocked();
  expect(hooks.paused).toBe(true);
  expect(seen).toEqual(["pause"]);
});

test("userPause/userPlay/userSeek emit the same events, are not recorded as calls, and ignore the autoplay block", async () => {
  const { hooks, seen } = await rig((h) => { h.autoplayBlocked(); });
  const before = hooks.calls.length;
  hooks.userPlay();
  expect(hooks.paused).toBe(false);
  hooks.userSeek(77);
  await sleep(10);
  hooks.userPause();
  expect(hooks.paused).toBe(true);
  expect(hooks.currentTime).toBeCloseTo(77, 1);
  expect(seen).toEqual(["play", "playing", "seeking", "seeked", "pause"]);
  expect(hooks.calls.length).toBe(before);
});

test("calls log records API methods with args", async () => {
  const { player, hooks } = await rig();
  await player.setCurrentTime(5);
  await player.play();
  const names = hooks.calls.map((c) => c.name);
  expect(names.includes("setCurrentTime") && names.includes("play")).toBe(true);
  expect(hooks.calls.find((c) => c.name === "setCurrentTime")?.args).toEqual([5]);
  expect(hooks.events.some((e) => e.type === "seeked" && typeof e.t === "number")).toBe(true);
});

test("reaching the duration emits ended, pauses, and getEnded is true", async () => {
  const { player, hooks, seen } = await rig((h) => { h.configure({ duration: 0.4 }); });
  await player.play();
  await sleep(600);
  expect(seen).toContain("ended");
  expect(hooks.paused).toBe(true);
  expect(await player.getEnded()).toBe(true);
  expect(hooks.currentTime).toBeCloseTo(0.4, 3);
});

test("off() removes one handler or all handlers for an event", async () => {
  const { player } = await rig();
  let a = 0;
  let b = 0;
  const fa = () => { a += 1; };
  player.on("pause", fa);
  player.on("pause", () => { b += 1; });
  await player.play();
  await player.pause();
  player.off("pause", fa);
  await player.play();
  await player.pause();
  expect([a, b]).toEqual([1, 2]);
  player.off("pause");
  await player.play();
  await player.pause();
  expect(b).toBe(2);
});

test("destroy() stops the clock and events and clears hooks.player", async () => {
  const { player, hooks, seen } = await rig();
  await player.play();
  await player.destroy();
  expect(hooks.player).toBeNull();
  seen.length = 0;
  await sleep(300);
  expect(seen).toEqual([]);
});
