import { describe, expect, test } from "bun:test";
import { playbackCaps } from "@omega/shared";
import type { PlayerErrorReason, PlayerEvent } from "../src/player/adapter";
import {
  AD_FROZEN_MS,
  ECHO_WINDOW_MS,
  LIVE_RESUME_MS,
  PUSH_LAG_MS,
  QUALITY_ECHO_MS,
  READY_TIMEOUT_MS,
  SEEK_ECHO_MS,
  attachTwitch,
  createTwitchMount,
  type TwitchEmbed,
} from "../src/player/twitch";
import type { TwitchLoad } from "../src/player/twitch-loader";
import { asTwitchNamespace } from "../src/player/twitch-types";
import { tvFrame, type TvTwitch } from "../src/tv";
import { FakeContainer, fakeTwitch, iframe, sdkSrc, type FakeTwitchOptions, type FakeTwitchPlayer } from "./support/fake-twitch";

/** A constructor whose instances have none of the player's methods. */
class NotAPlayer {
  readonly kind = "not-a-player";
}

const ORIGIN = "https://abc.ngrok-free.app";
const LIVE = { provider: "twitch", kind: "live", channel: "some_streamer", url: "https://player.twitch.tv/?channel=some_streamer" } as const;
const VOD = { provider: "twitch", kind: "vod", videoId: "1234567890", url: "https://player.twitch.tv/?video=v1234567890" } as const;

function frameOf(e: TwitchEmbed): TvTwitch {
  const f = tvFrame(e, ORIGIN);
  if (f?.kind !== "twitch") throw new Error("expected a Twitch frame");
  return f;
}

interface Timer {
  fn: () => void;
  ms: number;
  cleared: boolean;
}

function setup(embed: TwitchEmbed = VOD, o: FakeTwitchOptions = {}) {
  const t = { now: 0 };
  const timers: Timer[] = [];
  const { twitch, players } = fakeTwitch(o);
  const ns = asTwitchNamespace(twitch);
  if (ns === null) throw new Error("fake Twitch rejected by the guard");
  const box = new FakeContainer();
  const frame = frameOf(embed);
  const messages = new Set<(source: unknown) => void>();
  const adapter = attachTwitch(ns, box.asElement(), {
    embed,
    frame,
    now: () => t.now,
    messages: (fn) => {
      messages.add(fn);
      return () => messages.delete(fn);
    },
    setTimeout: (fn, ms) => {
      const h = { fn, ms, cleared: false };
      timers.push(h);
      return h;
    },
    clearTimeout: (h) => {
      h.cleared = true;
    },
  });
  if (adapter === null) throw new Error("attach refused the fake player");
  const p = players[0];
  if (p === undefined) throw new Error("no player created");
  const events: PlayerEvent[] = [];
  adapter.onEvent((e) => events.push(e));
  const ready = () => {
    p.playback = "Ready";
    p.duration = embed.kind === "vod" ? 3600 : 0;
    p.fire("ready");
  };
  /** The SDK's cached state after an UPDATE_STATE push. */
  const push = (s: { playback?: string; time?: number }) => {
    if (s.playback !== undefined) {
      p.playback = s.playback;
      p.paused = s.playback === "Idle";
      p.ended = s.playback === "Ended";
    }
    if (s.time !== undefined) p.currentTime = s.time;
  };
  /** A postMessage reaches the page (the SDK's own listener has already updated its cache). Default: from our player's iframe. */
  const deliver = (source: unknown = box.children[0]?.contentWindow) => {
    for (const fn of messages) fn(source);
  };
  return { t, timers, p, box, frame, adapter, events, ready, push, deliver, messages };
}

const intents = (events: PlayerEvent[]) => events.filter((e) => e.type === "intent");
const clear = (p: FakeTwitchPlayer) => (p.calls.length = 0);

describe("attachTwitch", () => {
  test("renders into our container with exactly the frozen options tvFrame() derived (parent = this host)", () => {
    const { p, box, frame } = setup(LIVE);
    expect(p.target).toBe(box);
    expect(p.options).toBe(frame.options);
    expect(p.options).toEqual({ channel: "some_streamer", parent: ["abc.ngrok-free.app"], width: "100%", height: "100%", autoplay: true, muted: false });
  });

  test("not ready until the SDK's ready event; commands before it are dropped", () => {
    const { adapter, p, events, ready } = setup();
    expect(adapter.ready()).toBe(false);
    expect(adapter.state()).toBe("unstarted");
    adapter.play();
    adapter.seek(3);
    adapter.setVolume(20);
    expect(p.calls).toEqual([]);
    ready();
    expect(adapter.ready()).toBe(true);
    expect(events).toContainEqual({ type: "ready" });
  });

  test("commands map to the SDK; volume is 0–1; the rate can't be set", () => {
    const { adapter, p, ready } = setup();
    ready();
    adapter.play();
    adapter.pause();
    adapter.seek(12.5);
    adapter.setRate(1.05);
    adapter.setVolume(40);
    adapter.unmute();
    expect(p.calls).toEqual([["play"], ["pause"], ["seek", 12.5], ["setVolume", 0.4], ["setMuted", false]]);
    expect(adapter.rates()).toEqual([1]);
  });

  test("caps come from the embed: VOD seeks without rate, live does neither", () => {
    expect(setup(VOD).adapter.caps).toEqual(playbackCaps(VOD));
    expect(setup(LIVE).adapter.caps).toEqual({ seek: false, live: true, rate: "no" });
  });

  test("live: seek is a no-op and there is no position or duration", () => {
    const { adapter, p, ready, push } = setup(LIVE);
    ready();
    push({ playback: "Playing", time: 1234 });
    adapter.seek(30);
    expect(p.calls).toEqual([]);
    expect(adapter.time()).toBe(0);
    expect(adapter.duration()).toBe(0);
  });

  test("VOD duration is the SDK's, guarded", () => {
    const { adapter, p, ready } = setup();
    ready();
    expect(adapter.duration()).toBe(3600);
    p.duration = Number.NaN;
    expect(adapter.duration()).toBe(0);
    p.duration = "3600";
    expect(adapter.duration()).toBe(0);
  });

  test("state comes from the pushed playback string", () => {
    const { adapter, ready, push } = setup();
    ready();
    expect(adapter.state()).toBe("cued");
    for (const [playback, want] of [
      ["Playing", "playing"],
      ["Idle", "paused"],
      ["Buffering", "buffering"],
      ["Ended", "ended"],
      ["Ready", "cued"],
    ] as const) {
      push({ playback });
      expect(adapter.state()).toBe(want);
    }
  });

  test("without getPlayerState() it falls back to isPaused()/getEnded()", () => {
    const { adapter, p, ready } = setup();
    ready();
    p.hasPlayerState = false;
    p.paused = true;
    expect(adapter.state()).toBe("paused");
    p.paused = false;
    expect(adapter.state()).toBe("playing");
    p.ended = true;
    expect(adapter.state()).toBe("ended");
  });

  test("time extrapolates the cached currentTime while playing, capped at +1 s past the push; not while paused", () => {
    const { t, adapter, ready, push } = setup();
    ready();
    push({ playback: "Playing", time: 100 });
    // A periodic push carries a currentTime PUSH_LAG_MS old (OME-396).
    expect(adapter.time()).toBeCloseTo(100.2, 6);
    t.now += 200;
    expect(adapter.time()).toBeCloseTo(100.4, 6);
    push({ time: 100.25 });
    expect(adapter.time()).toBeCloseTo(100.4, 6);
    t.now += 1500;
    expect(adapter.time()).toBeCloseTo(101.4, 6);
    push({ playback: "Idle", time: 101.5 });
    t.now += 800;
    expect(adapter.time()).toBe(101.5);
  });

  test("a periodic push while playing is PUSH_LAG_MS old; a paused one is exact (OME-396)", () => {
    expect(PUSH_LAG_MS).toBe(200);
    const { t, adapter, ready, push, deliver } = setup();
    ready();
    push({ playback: "Idle", time: 40 });
    deliver();
    expect(adapter.time()).toBe(40);
    push({ playback: "Playing" });
    deliver();
    t.now += 1060;
    push({ time: 40.86 });
    deliver();
    expect(adapter.time()).toBeCloseTo(41.06, 6);
    t.now += 1060;
    push({ time: 41.92 });
    deliver();
    t.now += 100;
    expect(adapter.time()).toBeCloseTo(42.22, 6);
  });

  test("the cache is read when our iframe's message arrives, so time runs from the push, not from the next tick (OME-396)", () => {
    const { t, adapter, ready, push, deliver } = setup();
    ready();
    push({ playback: "Playing", time: 10 });
    deliver();
    t.now += 1060;
    push({ time: 10.86 });
    deliver();
    // The sync loop reads 240 ms later: the push arrived then, so the clock has run 240 ms since.
    t.now += 240;
    expect(adapter.time()).toBeCloseTo(11.3, 6);
  });

  test("messages from other windows don't read the cache; destroy() stops listening", () => {
    const { t, adapter, ready, push, deliver, messages } = setup();
    ready();
    push({ playback: "Playing", time: 10 });
    deliver();
    t.now += 1060;
    push({ time: 10.86 });
    deliver({});
    t.now += 240;
    // Read only now: the push is taken as arriving at this read.
    expect(adapter.time()).toBeCloseTo(11.06, 6);
    adapter.destroy();
    expect(messages.size).toBe(0);
  });

  test("without an iframe window to match, no message reads the cache (a null source isn't ours)", () => {
    const { t, adapter, ready, push, deliver } = setup(VOD, { render: (opts) => [iframe(sdkSrc(opts), "IFRAME", null)] });
    ready();
    push({ playback: "Playing", time: 10 });
    expect(adapter.time()).toBeCloseTo(10.2, 6);
    t.now += 1060;
    push({ time: 10.86 });
    deliver(null);
    t.now += 240;
    expect(adapter.time()).toBeCloseTo(11.06, 6);
  });

  test("a fresh push right after play doesn't overshoot by the lag: the lower of it and the previous reading wins (OME-396)", () => {
    const { t, adapter, ready, push, deliver } = setup();
    ready();
    push({ playback: "Idle", time: 16.278 });
    deliver();
    t.now += 1000;
    // Play: the state push holds the paused position; ~230 ms later a fresh push (not 200 ms old).
    push({ playback: "Playing" });
    deliver();
    t.now += 229;
    push({ time: 16.549 });
    deliver();
    expect(adapter.time()).toBeCloseTo(16.507, 6);
    // The next periodic push is 200 ms old again and is taken as is.
    t.now += 999;
    push({ time: 17.35 });
    deliver();
    expect(adapter.time()).toBeCloseTo(17.55, 6);
  });

  test("a reading far from the carried one (a jump) is taken as is, lag added", () => {
    const { t, adapter, ready, push, deliver } = setup();
    ready();
    push({ playback: "Playing", time: 5 });
    deliver();
    t.now += 1000;
    push({ time: 300 });
    deliver();
    expect(adapter.time()).toBeCloseTo(300.2, 6);
  });

  test("a seek moves time at once; the stale cached value until the next push doesn't undo it", () => {
    const { t, adapter, ready, push } = setup();
    ready();
    push({ playback: "Idle", time: 50 });
    expect(adapter.time()).toBe(50);
    adapter.seek(300);
    expect(adapter.time()).toBe(300);
    t.now += 100;
    expect(adapter.time()).toBe(300);
    push({ time: 300.1 });
    expect(adapter.time()).toBeCloseTo(300.1, 6);
  });

  test("ad: a VOD that says Playing while its clock is frozen for > 2 s is in an ad; it ends when time moves", () => {
    const { t, adapter, ready, push } = setup();
    ready();
    push({ playback: "Playing", time: 10 });
    expect(adapter.state()).toBe("playing");
    t.now += AD_FROZEN_MS - 50;
    expect(adapter.state()).toBe("playing");
    t.now += 100;
    expect(adapter.state()).toBe("ad");
    // No extrapolation while the room's video isn't showing (the reading keeps its push lag).
    expect(adapter.time()).toBeCloseTo(10 + PUSH_LAG_MS / 1000, 6);
    push({ time: 10.25 });
    expect(adapter.state()).toBe("playing");
  });

  test("a frozen clock right after the player starts playing isn't an ad yet", () => {
    const { t, adapter, ready, push } = setup();
    ready();
    push({ playback: "Idle", time: 10 });
    t.now += 10_000;
    expect(adapter.state()).toBe("paused");
    push({ playback: "Playing" });
    expect(adapter.state()).toBe("playing");
    t.now += AD_FROZEN_MS + 100;
    expect(adapter.state()).toBe("ad");
  });

  test("live is never an ad (no clock to watch)", () => {
    const { t, adapter, ready, push } = setup(LIVE);
    ready();
    push({ playback: "Playing", time: 0 });
    t.now += 10_000;
    expect(adapter.state()).toBe("playing");
  });

  test("a play/pause inside the player (not an echo of ours) becomes an intent", () => {
    const { t, adapter, p, events, ready, push } = setup();
    ready();
    adapter.play();
    push({ playback: "Playing", time: 20 });
    p.fire("play");
    p.fire("playing");
    expect(intents(events)).toEqual([]);
    t.now += ECHO_WINDOW_MS + 500;
    push({ playback: "Idle", time: 21.5 });
    p.fire("pause");
    expect(intents(events)).toEqual([{ type: "intent", playing: false, position: 21.5 }]);
    expect(events).toContainEqual({ type: "state", state: "paused" });
  });

  test("live: a pause/play from the player right after our resume (mid-roll at the live edge) is not an intent", () => {
    const { t, adapter, p, events, ready, push } = setup(LIVE);
    ready();
    adapter.play();
    push({ playback: "Playing" });
    p.fire("play");
    t.now += ECHO_WINDOW_MS + 500;
    push({ playback: "Idle" });
    p.fire("pause");
    expect(events).toContainEqual({ type: "state", state: "paused" });
    t.now = LIVE_RESUME_MS - 100;
    push({ playback: "Playing" });
    p.fire("play");
    p.fire("playing");
    expect(events.at(-1)).toEqual({ type: "state", state: "playing" });
    expect(intents(events)).toEqual([]);
  });

  test("live: a pause later than the resume window is the member's", () => {
    const { t, adapter, p, events, ready, push } = setup(LIVE);
    ready();
    adapter.play();
    push({ playback: "Playing" });
    p.fire("play");
    t.now += LIVE_RESUME_MS + 100;
    push({ playback: "Idle" });
    p.fire("pause");
    expect(intents(events)).toEqual([{ type: "intent", playing: false, position: 0 }]);
  });

  test("live: the resume window follows our play only; a play after our pause is the member's", () => {
    const { t, adapter, p, events, ready, push } = setup(LIVE);
    ready();
    adapter.play();
    push({ playback: "Playing" });
    p.fire("play");
    t.now += LIVE_RESUME_MS + 100;
    adapter.pause();
    push({ playback: "Idle" });
    p.fire("pause");
    t.now += ECHO_WINDOW_MS + 500;
    push({ playback: "Playing" });
    p.fire("play");
    expect(intents(events)).toEqual([{ type: "intent", playing: true, position: 0 }]);
  });

  test("VOD keeps the 1 s echo window after a resume (no live resume window)", () => {
    const { t, adapter, p, events, ready, push } = setup();
    ready();
    adapter.play();
    push({ playback: "Playing", time: 20 });
    p.fire("play");
    t.now += ECHO_WINDOW_MS + 500;
    expect(t.now).toBeLessThan(LIVE_RESUME_MS);
    push({ playback: "Idle", time: 21.5 });
    p.fire("pause");
    expect(intents(events)).toEqual([{ type: "intent", playing: false, position: 21.5 }]);
  });

  test("play/pause before we ever commanded the player (autoplay at load) is not an intent", () => {
    const { t, p, events, ready, push } = setup();
    ready();
    push({ playback: "Playing" });
    p.fire("play");
    t.now += 5000;
    push({ playback: "Idle" });
    p.fire("pause");
    expect(intents(events)).toEqual([]);
  });

  test("the echo of our own pause is not an intent", () => {
    const { t, adapter, p, events, ready, push } = setup();
    ready();
    adapter.play();
    push({ playback: "Playing" });
    p.fire("play");
    t.now += 5000;
    adapter.pause();
    t.now += 300;
    push({ playback: "Idle" });
    p.fire("pause");
    expect(intents(events)).toEqual([]);
  });

  test("a user seek inside a VOD becomes an intent at the new position, keeping play state", () => {
    const { t, adapter, p, events, ready, push } = setup();
    ready();
    adapter.play();
    push({ playback: "Playing", time: 5 });
    p.fire("play");
    t.now += 5000;
    push({ time: 600 });
    p.fire("seek", { position: 600 });
    expect(intents(events)).toEqual([{ type: "intent", playing: true, position: 600 }]);
  });

  test("the seek event for our own seek is an echo, even when the HLS seek takes seconds", () => {
    const { t, adapter, p, events, ready, push } = setup();
    ready();
    adapter.play();
    push({ playback: "Playing", time: 5 });
    p.fire("play");
    t.now += 5000;
    adapter.seek(90);
    t.now += SEEK_ECHO_MS - 500;
    p.fire("seek", { position: 90 });
    expect(intents(events)).toEqual([]);
    // Only one echo per seek: a later user seek counts.
    t.now += 2000;
    p.fire("seek", { position: 700 });
    expect(intents(events)).toEqual([{ type: "intent", playing: true, position: 700 }]);
  });

  test("live: the jump to the live edge after a resume is not a seek intent", () => {
    const { t, adapter, p, events, ready, push } = setup(LIVE);
    ready();
    adapter.play();
    push({ playback: "Playing" });
    p.fire("play");
    t.now += 5000;
    p.fire("seek");
    expect(intents(events)).toEqual([]);
  });

  test("playbackBlocked → muted play and the Unmute prompt", () => {
    const { adapter, p, events, ready } = setup();
    ready();
    clear(p);
    p.fire("playbackBlocked");
    expect(p.calls).toEqual([["setMuted", true], ["play"]]);
    expect(events).toContainEqual({ type: "autoplay-blocked" });
    adapter.unmute();
    expect(p.calls.at(-1)).toEqual(["setMuted", false]);
  });

  test("error codes map to provider-neutral reasons", () => {
    const cases: [unknown, PlayerErrorReason, string][] = [
      [{ code: 1 }, "restricted", "1"],
      [{ code: 5 }, "restricted", "5"],
      [{ code: 6 }, "restricted", "6"],
      [{ code: 5000 }, "not-found", "5000"],
      [{ code: 2000 }, "other", "2000"],
      [{ code: "vod_manifest_restricted" }, "restricted", "vod_manifest_restricted"],
      [{ code: "something_else" }, "other", "something_else"],
      [undefined, "other", "unknown"],
      [{ code: { toString: "x" } }, "other", "unknown"],
    ];
    for (const [params, reason, code] of cases) {
      const { p, events, ready } = setup();
      ready();
      p.fire("error", params);
      expect(events.filter((e) => e.type === "error")).toEqual([{ type: "error", reason, code }]);
    }
  });

  test("offline is an error that clears itself: no state events until online", () => {
    const { adapter, p, events, ready, push } = setup(LIVE);
    ready();
    adapter.play();
    p.fire("offline");
    expect(events.at(-1)).toEqual({ type: "error", reason: "offline", code: "offline" });
    const n = events.length;
    push({ playback: "Playing" });
    p.fire("play");
    expect(events.length).toBe(n);
    p.fire("online");
    expect(events.at(-1)).toEqual({ type: "state", state: "playing" });
  });

  test("no ready within 10 s (wrong parent: no signal from the SDK) → a timeout error", () => {
    const { timers, events } = setup();
    const readyTimer = timers.find((h) => h.ms === READY_TIMEOUT_MS);
    expect(readyTimer).toBeDefined();
    expect(READY_TIMEOUT_MS).toBe(10_000);
    readyTimer?.fn();
    expect(events).toContainEqual({ type: "error", reason: "timeout", code: "ready-timeout" });
  });

  test("ready clears the timeout", () => {
    const { timers, ready } = setup();
    ready();
    expect(timers.every((h) => h.cleared)).toBe(true);
  });

  test("destroy removes our SDK listeners, clears timers and silences the adapter", () => {
    const { adapter, p, events, timers, ready } = setup();
    ready();
    const n = events.length;
    adapter.destroy();
    expect(p.listenerCount()).toBe(0);
    expect(timers.every((h) => h.cleared)).toBe(true);
    expect(adapter.ready()).toBe(false);
    adapter.play();
    expect(p.calls).toEqual([]);
    p.fire("pause");
    expect(events.length).toBe(n);
  });

  test("a constructed object that isn't a player is refused", () => {
    const ns = asTwitchNamespace({ Player: NotAPlayer });
    if (ns === null) throw new Error("guard");
    const box = new FakeContainer();
    const r = attachTwitch(ns, box.asElement(), { embed: VOD, frame: frameOf(VOD), now: () => 0, setTimeout: () => 0, clearTimeout: () => undefined, messages: () => () => undefined });
    expect(r).toBeNull();
  });
});

describe("asTwitchNamespace (boundary guard for window.Twitch)", () => {
  test("accepts an object with a Player constructor only", () => {
    expect(asTwitchNamespace({ Player: NotAPlayer })).not.toBeNull();
    for (const bad of [undefined, null, 1, "Twitch", {}, { Player: 1 }, { Player: {} }]) expect(asTwitchNamespace(bad)).toBeNull();
  });
});

describe("createTwitchMount", () => {
  const ok = (twitch: unknown): (() => Promise<TwitchLoad>) => {
    const ns = asTwitchNamespace(twitch);
    if (ns === null) throw new Error("guard");
    return () => Promise.resolve({ ok: true, twitch: ns });
  };
  const ctx = (embed: TwitchEmbed, box: FakeContainer) => ({ embed, frame: frameOf(embed), target: { iframe: null, container: box.asElement() }, now: () => 0 });

  test("mounts when the SDK rendered exactly our player", async () => {
    const box = new FakeContainer();
    const r = await createTwitchMount(ok(fakeTwitch().twitch))(ctx(LIVE, box));
    expect(r.ok).toBe(true);
    expect(box.children).toHaveLength(1);
    if (r.ok) r.player.destroy();
  });

  test("anything else the SDK rendered is removed and ends in invalid", async () => {
    const renders = [
      (o: TvTwitch["options"]) => [iframe(sdkSrc(o).replace("player.twitch.tv", "evil.example"))],
      (o: TvTwitch["options"]) => [iframe(sdkSrc(o, { channel: "other" }))],
      (o: TvTwitch["options"]) => [iframe(sdkSrc(o, { parent: "evil.example" }))],
      (o: TvTwitch["options"]) => [iframe(sdkSrc(o)), iframe(sdkSrc(o))],
      (o: TvTwitch["options"]) => [iframe(sdkSrc(o), "DIV")],
      () => [],
    ];
    for (const render of renders) {
      const box = new FakeContainer();
      const { twitch, players } = fakeTwitch({ render });
      const r = await createTwitchMount(ok(twitch))(ctx(LIVE, box));
      expect(r).toEqual({ ok: false, reason: "invalid" });
      expect(box.children).toEqual([]);
      expect(players[0]?.listenerCount()).toBe(0);
    }
  });

  test("an SDK that didn't load → load-failed or timeout, and nothing is constructed", async () => {
    const box = new FakeContainer();
    for (const [reason, want] of [
      ["error", "load-failed"],
      ["invalid", "load-failed"],
      ["timeout", "timeout"],
    ] as const) {
      const r = await createTwitchMount(() => Promise.resolve({ ok: false, reason }))(ctx(VOD, box));
      expect(r).toEqual({ ok: false, reason: want });
    }
  });

  test("a frame that isn't this embed's Twitch frame is refused before the SDK loads", async () => {
    const box = new FakeContainer();
    let loads = 0;
    const load = () => {
      loads++;
      return ok(fakeTwitch().twitch)();
    };
    const mount = createTwitchMount(load);
    expect(await mount({ ...ctx(LIVE, box), frame: frameOf(VOD) })).toEqual({ ok: false, reason: "invalid" });
    const yt = tvFrame({ provider: "youtube", videoId: "dQw4w9WgXcQ", url: "https://www.youtube.com/embed/dQw4w9WgXcQ" }, ORIGIN);
    if (yt === null) throw new Error("frame");
    expect(await mount({ ...ctx(LIVE, box), frame: yt })).toEqual({ ok: false, reason: "invalid" });
    expect(loads).toBe(0);
  });
});

/** What the served v1.js caches from the iframe: objects whose `group` is what `setQuality()` takes. */
const TWITCH_QUALITIES = [
  { name: "Auto", group: "auto" },
  { name: "1080p60 (source)", group: "chunked", isDefault: true },
  { name: "720p60", group: "720p60" },
  { name: "480p", group: "480p30" },
];

describe("attachTwitch quality (per viewer, OME-599)", () => {
  test("options are the SDK's list as { id: group, label: name }; current is getQuality()", () => {
    const { adapter, p, ready } = setup();
    p.qualities = TWITCH_QUALITIES;
    p.quality = "chunked";
    ready();
    expect(adapter.quality?.options()).toEqual([
      { id: "auto", label: "Auto" },
      { id: "chunked", label: "1080p60 (source)" },
      { id: "720p60", label: "720p60" },
      { id: "480p30", label: "480p" },
    ]);
    expect(adapter.quality?.current()).toBe("chunked");
  });

  test("the list is guarded: plain strings are taken as both id and label; garbage and duplicates are dropped", () => {
    const { adapter, p, ready } = setup(LIVE);
    p.qualities = ["160p30", { group: "360p30" }, { name: "no group" }, 42, null, { group: "" }, { group: "360p30", name: "again" }, { group: "x".repeat(200) }];
    ready();
    expect(adapter.quality?.options()).toEqual([
      { id: "160p30", label: "160p30" },
      { id: "360p30", label: "360p30" },
    ]);
  });

  test("not ready, or a list that isn't an array → no options (no picker)", () => {
    const { adapter, p, ready } = setup();
    p.qualities = TWITCH_QUALITIES;
    expect(adapter.quality?.options()).toEqual([]);
    p.qualities = "chunked";
    ready();
    expect(adapter.quality?.options()).toEqual([]);
  });

  test("the list is re-read when the player starts playing (Twitch fills it after ready), with a quality event when it changed", () => {
    const { adapter, p, events, ready, push } = setup();
    ready();
    expect(adapter.quality?.options()).toEqual([]);
    p.qualities = TWITCH_QUALITIES;
    push({ playback: "Playing", time: 1 });
    p.fire("playing");
    expect(adapter.quality?.options()).toHaveLength(4);
    expect(events.filter((e) => e.type === "quality")).toHaveLength(1);
    p.fire("playing");
    expect(events.filter((e) => e.type === "quality")).toHaveLength(1);
  });

  test("set() calls setQuality with a listed id and emits a quality event; an unlisted id sends nothing", () => {
    const { adapter, p, events, ready } = setup();
    p.qualities = TWITCH_QUALITIES;
    ready();
    clear(p);
    adapter.quality?.set("720p60");
    expect(p.calls).toEqual([["setQuality", "720p60"]]);
    expect(adapter.quality?.current()).toBe("720p60");
    expect(events.at(-1)).toEqual({ type: "quality" });
    adapter.quality?.set("4k");
    expect(p.calls).toEqual([["setQuality", "720p60"]]);
  });

  test("never by remounting: set() keeps the one player and its iframe", () => {
    const { adapter, p, box, ready } = setup();
    p.qualities = TWITCH_QUALITIES;
    ready();
    const frame = box.children[0];
    adapter.quality?.set("480p30");
    expect(box.children).toHaveLength(1);
    expect(box.children[0]).toBe(frame);
    expect(p.calls.filter(([n]) => n === "destroy")).toEqual([]);
  });

  test("a quality switch is never a room action: its pause/play and seek inside the echo window send no intent", () => {
    const { t, adapter, p, events, ready, push } = setup();
    p.qualities = TWITCH_QUALITIES;
    ready();
    adapter.play();
    push({ playback: "Playing", time: 20 });
    p.fire("playing");
    t.now += 10_000;
    adapter.quality?.set("480p30");
    t.now += 300;
    push({ playback: "Idle", time: 30.3 });
    p.fire("pause");
    t.now += QUALITY_ECHO_MS - 1000;
    push({ playback: "Playing", time: 30.3 });
    p.fire("seek", { position: 30.3 });
    p.fire("playing");
    expect(intents(events)).toEqual([]);
    // After the window the member's own pause counts again.
    t.now += 2000;
    push({ playback: "Idle", time: 32 });
    p.fire("pause");
    expect(intents(events)).toEqual([{ type: "intent", playing: false, position: 32 }]);
  });

  test("live: a quality switch's pause/play is not an intent either", () => {
    const { t, adapter, p, events, ready, push } = setup(LIVE);
    p.qualities = TWITCH_QUALITIES;
    ready();
    adapter.play();
    push({ playback: "Playing" });
    p.fire("playing");
    t.now += LIVE_RESUME_MS + 1000;
    adapter.quality?.set("720p60");
    push({ playback: "Idle" });
    p.fire("pause");
    push({ playback: "Playing" });
    p.fire("playing");
    expect(intents(events)).toEqual([]);
  });

  test("before ready or after destroy, set() sends nothing", () => {
    const { adapter, p, ready } = setup();
    p.qualities = TWITCH_QUALITIES;
    adapter.quality?.set("720p60");
    ready();
    adapter.destroy();
    adapter.quality?.set("720p60");
    expect(p.calls.filter(([n]) => n === "setQuality")).toEqual([]);
  });
});
