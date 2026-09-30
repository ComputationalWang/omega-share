import { describe, expect, test } from "bun:test";
import type { PlayerEvent } from "../src/player/adapter";
import { ECHO_WINDOW_MS, READY_TIMEOUT_MS, SEEK_ECHO_MS, VIMEO_RATES, attachVimeo, createVimeoMount } from "../src/player/vimeo";
import type { VimeoLoad } from "../src/player/vimeo-loader";
import { tvFrame } from "../src/tv";
import { fakeVimeo, flush, named, type FakeVimeoPlayer } from "./support/fake-vimeo";

const EMBED = { provider: "vimeo", videoId: "76979871", hash: null, url: "https://player.vimeo.com/video/76979871" } as const;

interface Timer {
  fn: () => void;
  ms: number;
  cleared: boolean;
}

function setup() {
  const t = { now: 0 };
  const timers: Timer[] = [];
  const { vm, players } = fakeVimeo();
  const iframe = {} as HTMLIFrameElement;
  const adapter = attachVimeo(vm, iframe, {
    embed: EMBED,
    now: () => t.now,
    setTimeout: (fn, ms) => {
      const x = { fn, ms, cleared: false };
      timers.push(x);
      return x;
    },
    clearTimeout: (x) => {
      x.cleared = true;
    },
  });
  const p = players[0];
  if (p === undefined) throw new Error("no player created");
  const events: PlayerEvent[] = [];
  adapter.onEvent((e) => events.push(e));
  /** The iframe answers ready; the rate probe resolves (paid plan) or rejects (free plan). */
  const ready = async (rateOk = true) => {
    p.readyP.resolve(undefined);
    await flush();
    const probe = p.rateP[0];
    if (probe === undefined) throw new Error("no rate probe");
    if (rateOk) probe.resolve(1);
    else probe.reject(named("Error"));
    await flush();
  };
  return { t, timers, players, iframe, adapter, p, events, ready };
}

const intents = (events: PlayerEvent[]) => events.filter((e) => e.type === "intent");
const clear = (p: FakeVimeoPlayer) => (p.calls.length = 0);

describe("attachVimeo", () => {
  test("attaches the SDK to our own iframe, with no options (tvFrame() owns src, sandbox and allow)", () => {
    const { players, iframe } = setup();
    expect(players).toHaveLength(1);
    expect(players[0]?.el).toBe(iframe);
    expect(players[0]?.extraArgs).toBe(0);
  });

  test("not ready until the iframe answers and the rate probe settles; commands before that are dropped", async () => {
    const { adapter, p, events } = setup();
    adapter.play();
    adapter.seek(3);
    expect(p.calls).toEqual([]);
    p.readyP.resolve(undefined);
    await flush();
    expect(p.calls).toEqual([["setPlaybackRate", 1]]);
    // rates() must be final once ready() is true (PlayerAdapter, caps.rate "probe").
    expect(adapter.ready()).toBe(false);
    p.rateP[0]?.resolve(1);
    await flush();
    expect(adapter.ready()).toBe(true);
    expect(events).toContainEqual({ type: "ready" });
    expect(adapter.caps).toEqual({ seek: true, live: false, rate: "probe" });
  });

  test("rate probe accepted → rate nudges are offered and forwarded", async () => {
    const { adapter, p, ready } = setup();
    await ready(true);
    expect(adapter.rates()).toEqual(VIMEO_RATES);
    expect(VIMEO_RATES).toContain(0.75);
    expect(VIMEO_RATES).toContain(1.25);
    clear(p);
    adapter.setRate(1.05);
    expect(p.calls).toEqual([["setPlaybackRate", 1.05]]);
  });

  test("rate probe rejected (free-plan owner) → rates() is [1] (seek-only) and setRate sends nothing", async () => {
    const { adapter, p, ready } = setup();
    await ready(false);
    expect(adapter.ready()).toBe(true);
    expect(adapter.rates()).toEqual([1]);
    clear(p);
    adapter.setRate(1.05);
    expect(p.calls).toEqual([]);
  });

  test("commands map to the SDK; volume is 0–1 there", async () => {
    const { adapter, p, ready } = setup();
    await ready();
    clear(p);
    adapter.play();
    adapter.pause();
    adapter.seek(12.5);
    adapter.unmute();
    adapter.setVolume(40);
    expect(p.calls).toEqual([["play"], ["pause"], ["setCurrentTime", 12.5], ["setMuted", false], ["setVolume", 0.4]]);
  });

  test("time() extrapolates the last pushed time while playing, at the current rate, capped at +1 s", async () => {
    const { t, adapter, p, ready } = setup();
    await ready();
    p.fire("play", { seconds: 10, percent: 0, duration: 300 });
    p.fire("timeupdate", { seconds: 10, percent: 0, duration: 300 });
    t.now = 200;
    expect(adapter.time()).toBeCloseTo(10.2, 6);
    adapter.setRate(1.25);
    p.rateP[1]?.resolve(1.25);
    await flush();
    p.fire("timeupdate", { seconds: 10.2, percent: 0, duration: 300 });
    t.now = 600;
    expect(adapter.time()).toBeCloseTo(10.7, 6);
    t.now = 10_000;
    expect(adapter.time()).toBeCloseTo(11.2, 6);
    p.fire("pause", { seconds: 11, percent: 0, duration: 300 });
    t.now = 20_000;
    expect(adapter.time()).toBe(11);
  });

  test("garbage in a push is ignored: time and duration keep their last good values", async () => {
    const { adapter, p, ready } = setup();
    await ready();
    p.fire("pause", { seconds: 5, percent: 0, duration: 300 });
    for (const bad of [undefined, null, "x", { seconds: NaN }, { seconds: -1 }, { seconds: "3" }]) p.fire("timeupdate", bad);
    expect(adapter.time()).toBe(5);
    expect(adapter.duration()).toBe(300);
  });

  test("duration is learned at ready", async () => {
    const { adapter, ready } = setup();
    expect(adapter.duration()).toBe(0);
    await ready();
    expect(adapter.duration()).toBe(300);
  });

  test("state follows play/pause/ended; bufferstart/bufferend → buffering and back", async () => {
    const { adapter, p, events, ready } = setup();
    expect(adapter.state()).toBe("unstarted");
    await ready();
    p.fire("play", { seconds: 0, percent: 0, duration: 300 });
    expect(adapter.state()).toBe("playing");
    p.fire("bufferstart");
    expect(adapter.state()).toBe("buffering");
    expect(events).toContainEqual({ type: "state", state: "buffering" });
    p.fire("bufferend");
    expect(adapter.state()).toBe("playing");
    p.fire("pause", { seconds: 3, percent: 0, duration: 300 });
    expect(adapter.state()).toBe("paused");
    p.fire("ended", { seconds: 300, percent: 1, duration: 300 });
    expect(adapter.state()).toBe("ended");
  });

  test("a pause the user clicked inside the player → intent; our own command's echo → none", async () => {
    const { t, adapter, p, events, ready } = setup();
    await ready();
    t.now = 1000;
    adapter.play();
    p.fire("play", { seconds: 4, percent: 0, duration: 300 });
    expect(intents(events)).toEqual([]);
    t.now = 1000 + ECHO_WINDOW_MS + 500;
    p.fire("pause", { seconds: 6, percent: 0, duration: 300 });
    expect(intents(events)).toEqual([{ type: "intent", playing: false, position: 6 }]);
  });

  test("a seek the user made inside the player → intent at the new position; our own seek's echo → none", async () => {
    const { t, adapter, p, events, ready } = setup();
    await ready();
    adapter.play();
    p.fire("play", { seconds: 0, percent: 0, duration: 300 });
    t.now = 5000;
    adapter.seek(30);
    p.fire("seeked", { seconds: 30, percent: 0.1, duration: 300 });
    expect(intents(events)).toEqual([]);
    t.now = 5000 + SEEK_ECHO_MS + 1;
    p.fire("seeked", { seconds: 90, percent: 0.3, duration: 300 });
    expect(intents(events)).toEqual([{ type: "intent", playing: true, position: 90 }]);
    expect(adapter.time()).toBe(90);
  });

  test("ready() rejected: PrivacyError → refused, PasswordError → restricted, NotFoundError → not-found, anything else → other (the OME-110 notice path)", async () => {
    for (const [name, reason] of [
      ["PrivacyError", "refused"],
      ["PasswordError", "restricted"],
      ["NotFoundError", "not-found"],
      ["UnsupportedError", "other"],
    ] as const) {
      const { adapter, p, events, timers } = setup();
      p.readyP.reject(named(name));
      await flush();
      expect(events).toEqual([{ type: "error", reason, code: name }]);
      expect(adapter.ready()).toBe(false);
      expect(timers[0]?.cleared).toBe(true);
    }
  });

  test("no answer from the iframe within the ready timeout → timeout error", async () => {
    const { timers, events } = setup();
    expect(timers[0]?.ms).toBe(READY_TIMEOUT_MS);
    timers[0]?.fn();
    await flush();
    expect(events).toEqual([{ type: "error", reason: "timeout", code: "ready-timeout" }]);
  });

  test("the iframe plays a different video than the room's → error, never ready", async () => {
    const { adapter, p, events } = setup();
    p.videoId = 12345;
    p.readyP.resolve(undefined);
    await flush();
    expect(adapter.ready()).toBe(false);
    expect(events).toEqual([{ type: "error", reason: "other", code: "wrong-video" }]);
  });

  test("a player error event maps like ready's; an error the SDK routes to a method's promise is not re-reported", async () => {
    const { p, events, ready } = setup();
    await ready();
    events.length = 0;
    p.fire("error", { name: "RangeError", message: "out of range", method: "setCurrentTime" });
    expect(events).toEqual([]);
    p.fire("error", { name: "PrivacyError", message: "private" });
    expect(events).toEqual([{ type: "error", reason: "refused", code: "PrivacyError" }]);
    events.length = 0;
    p.fire("error", { name: "NotFoundError", message: "not found" });
    expect(events).toEqual([{ type: "error", reason: "not-found", code: "NotFoundError" }]);
  });

  test("play() rejected by the browser → mute, play again, autoplay-blocked once", async () => {
    const { adapter, p, events, ready } = setup();
    await ready();
    clear(p);
    adapter.play();
    p.playP[0]?.reject(named("NotAllowedError"));
    await flush();
    expect(p.calls).toEqual([["play"], ["setMuted", true], ["play"]]);
    expect(events.filter((e) => e.type === "autoplay-blocked")).toHaveLength(1);
    p.playP[1]?.reject(named("NotAllowedError"));
    await flush();
    expect(events.filter((e) => e.type === "autoplay-blocked")).toHaveLength(1);
  });

  test("play() rejected with PasswordError → restricted error, no muted retry", async () => {
    const { adapter, p, events, ready } = setup();
    await ready();
    clear(p);
    adapter.play();
    p.playP[0]?.reject(named("PasswordError"));
    await flush();
    expect(p.calls).toEqual([["play"]]);
    expect(events).toContainEqual({ type: "error", reason: "restricted", code: "PasswordError" });
  });

  test("destroy unsubscribes every SDK listener, stops events and tears the SDK down", async () => {
    const { adapter, p, events, ready, timers } = setup();
    await ready();
    events.length = 0;
    adapter.destroy();
    expect(p.listenerCount()).toBe(0);
    expect(p.calls).toContainEqual(["destroy"]);
    expect(adapter.ready()).toBe(false);
    timers[0]?.fn();
    expect(events).toEqual([]);
  });

  test("destroyed before the iframe answered → never becomes ready", async () => {
    const { adapter, p, events } = setup();
    adapter.destroy();
    p.readyP.resolve(undefined);
    await flush();
    p.rateP[0]?.resolve(1);
    await flush();
    expect(adapter.ready()).toBe(false);
    expect(events).toEqual([]);
  });
});

describe("createVimeoMount", () => {
  const frame = tvFrame(EMBED, "http://localhost:5173");
  if (frame === null) throw new Error("no frame");

  test("needs our own iframe: without it → invalid, and the SDK isn't loaded", async () => {
    let loads = 0;
    const mount = createVimeoMount(() => {
      loads++;
      return Promise.resolve({ ok: false, reason: "error" } satisfies VimeoLoad);
    });
    const r = await mount({ embed: EMBED, frame, target: { iframe: null, container: {} as HTMLElement }, now: () => 0 });
    expect(r).toEqual({ ok: false, reason: "invalid" });
    expect(loads).toBe(0);
  });

  test("SDK load failures map to load-failed / timeout", async () => {
    const iframe = {} as HTMLIFrameElement;
    for (const [reason, want] of [
      ["error", "load-failed"],
      ["invalid", "load-failed"],
      ["timeout", "timeout"],
    ] as const) {
      const mount = createVimeoMount(() => Promise.resolve({ ok: false, reason }));
      expect(await mount({ embed: EMBED, frame, target: { iframe, container: iframe }, now: () => 0 })).toEqual({ ok: false, reason: want });
    }
  });

  test("loaded → an adapter attached to our iframe", async () => {
    const iframe = {} as HTMLIFrameElement;
    const { vm, players } = fakeVimeo();
    const mount = createVimeoMount(() => Promise.resolve({ ok: true, vimeo: vm }));
    const r = await mount({ embed: EMBED, frame, target: { iframe, container: iframe }, now: () => 0 });
    expect(r.ok).toBe(true);
    expect(players[0]?.el).toBe(iframe);
    if (r.ok) r.player.destroy();
  });
});
