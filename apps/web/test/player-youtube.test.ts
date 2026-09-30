import { describe, expect, test } from "bun:test";
import type { PlayerEvent, PlayerState } from "../src/player/adapter";
import { AD_RELEARN_MS, ECHO_WINDOW_MS, attachYouTube } from "../src/player/youtube";
import { fakeYt, type FakeYtPlayer } from "./support/fake-yt";

const VIDEO = "dQw4w9WgXcQ";

function setup() {
  const t = { now: 0 };
  const { yt, players } = fakeYt();
  const iframe = {} as HTMLIFrameElement;
  const adapter = attachYouTube(yt, iframe, { videoId: VIDEO, now: () => t.now });
  const p = players[0];
  if (p === undefined) throw new Error("no player created");
  const events: PlayerEvent[] = [];
  adapter.onEvent((e) => events.push(e));
  const ready = () => {
    p.videoData = { video_id: VIDEO };
    p.duration = 214;
    p.fire("onReady");
  };
  return { t, yt, players, iframe, adapter, p, events, ready };
}

const intents = (events: PlayerEvent[]) => events.filter((e) => e.type === "intent");
const clear = (p: FakeYtPlayer) => (p.calls.length = 0);

describe("attachYouTube", () => {
  test("attaches to our own iframe element with events only (never a videoId)", () => {
    const { players, iframe } = setup();
    expect(players).toHaveLength(1);
    const p = players[0];
    expect(p?.el).toBe(iframe);
    expect(p?.extraArgs).toBe(0);
    expect(Object.keys(p?.options ?? {})).toEqual(["events"]);
  });

  test("not ready until onReady; commands before it are dropped", () => {
    const { adapter, p, events, ready } = setup();
    expect(adapter.ready()).toBe(false);
    adapter.play();
    adapter.seek(3);
    expect(p.calls).toEqual([]);
    ready();
    expect(adapter.ready()).toBe(true);
    expect(events).toContainEqual({ type: "ready" });
  });

  test("commands map to the IFrame API", () => {
    const { adapter, p, ready } = setup();
    ready();
    adapter.play();
    adapter.pause();
    adapter.seek(12.5);
    adapter.setRate(1.05);
    adapter.unmute();
    adapter.setVolume(40);
    expect(p.calls).toEqual([
      ["playVideo"],
      ["pauseVideo"],
      ["seekTo", 12.5, true],
      ["setPlaybackRate", 1.05],
      ["unMute"],
      ["setVolume", 40],
    ]);
  });

  test("read-outs are guarded: non-finite time → 0, garbage rates → [1]", () => {
    const { adapter, p, ready } = setup();
    ready();
    p.currentTime = 42.5;
    expect(adapter.time()).toBe(42.5);
    for (const bad of [NaN, Infinity, "12", undefined, -3]) {
      p.currentTime = bad;
      expect(adapter.time()).toBe(0);
    }
    expect(adapter.rates()).toEqual([0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]);
    for (const bad of [null, "1", [1, "x"], [NaN], []]) {
      p.availableRates = bad;
      expect(adapter.rates()).toEqual([1]);
    }
  });

  test("state maps the numeric player states", () => {
    const { adapter, p, ready } = setup();
    ready();
    const table: [unknown, PlayerState][] = [
      [-1, "unstarted"],
      [0, "ended"],
      [1, "playing"],
      [2, "paused"],
      [3, "buffering"],
      [5, "cued"],
      [42, "unstarted"],
      ["1", "unstarted"],
    ];
    for (const [n, s] of table) {
      p.playerState = n;
      expect(adapter.state()).toBe(s);
    }
  });

  test("ad heuristic: another video id, or a duration unlike the content's, reads as 'ad'", () => {
    const { adapter, p, ready } = setup();
    ready();
    p.fire("onStateChange", 1);
    expect(adapter.state()).toBe("playing");
    p.videoData = { video_id: "fake-ad-0001" };
    p.fire("onStateChange", 1);
    expect(adapter.state()).toBe("ad");
    p.videoData = { video_id: VIDEO };
    p.fire("onStateChange", 1);
    p.duration = 15;
    expect(adapter.state()).toBe("ad");
    p.duration = 214;
    expect(adapter.state()).toBe("playing");
    p.videoData = null;
    p.fire("onStateChange", 1);
    expect(adapter.state()).toBe("playing");
  });

  test("the video id is read on player events, not on every state() poll", () => {
    const { adapter, p, ready } = setup();
    ready();
    p.fire("onStateChange", 1);
    let reads = 0;
    const orig = p.getVideoData.bind(p);
    p.getVideoData = () => {
      reads++;
      return orig();
    };
    for (let i = 0; i < 10; i++) adapter.state();
    expect(reads).toBe(0);
  });

  test("an ad at load doesn't poison the content duration", () => {
    const { adapter, p } = setup();
    p.videoData = { video_id: "fake-ad-0001" };
    p.duration = 15;
    p.fire("onReady");
    p.fire("onStateChange", 1);
    expect(adapter.state()).toBe("ad");
    p.videoData = { video_id: VIDEO };
    p.duration = 214;
    p.fire("onStateChange", 1);
    expect(adapter.state()).toBe("playing");
    p.duration = 15;
    expect(adapter.state()).toBe("ad");
  });

  test("a pre-roll that reports the content id is learned as the content only until it's proven wrong", () => {
    const { t, adapter, p } = setup();
    // onReady before metadata: no duration yet.
    p.videoData = { video_id: VIDEO };
    p.duration = 0;
    p.fire("onReady");
    // Pre-roll reports the content id and its own 15 s duration.
    p.duration = 15;
    p.fire("onStateChange", 1);
    expect(adapter.state()).toBe("playing");
    // Real content starts: duration differs, so it first reads as an ad...
    t.now = 16_000;
    p.duration = 214;
    p.fire("onStateChange", 1);
    expect(adapter.state()).toBe("ad");
    // ...but a mismatch that only the duration rule sees, and that lasts past AD_RELEARN_MS, re-learns the content.
    t.now = 16_000 + AD_RELEARN_MS + 1;
    expect(adapter.state()).toBe("playing");
    p.duration = 15;
    expect(adapter.state()).toBe("ad");
  });

  test("duration() is the room video's, 0 until known, and never an ad's", () => {
    const { adapter, p, ready } = setup();
    expect(adapter.duration()).toBe(0);
    ready();
    expect(adapter.duration()).toBe(214);
    p.videoData = { video_id: "adAdAdAdAdA" };
    p.duration = 15;
    p.fire("onStateChange", 1);
    expect(adapter.duration()).toBe(214);
  });

  test("state changes are forwarded as events", () => {
    const { p, events, ready } = setup();
    ready();
    p.fire("onStateChange", 3);
    expect(events).toContainEqual({ type: "state", state: "buffering" });
  });

  test("a click-pause inside the player (outside the echo window) becomes a control intent", () => {
    const { t, adapter, p, events, ready } = setup();
    ready();
    adapter.play();
    p.fire("onStateChange", 1);
    t.now = ECHO_WINDOW_MS + 500;
    p.currentTime = 33;
    p.fire("onStateChange", 2);
    expect(intents(events)).toEqual([{ type: "intent", playing: false, position: 33 }]);
    // Once reported, the new state is expected: a repeat is not a second intent.
    p.fire("onStateChange", 2);
    expect(intents(events)).toHaveLength(1);
  });

  test("a click-play becomes a play intent", () => {
    const { t, adapter, p, events, ready } = setup();
    ready();
    adapter.pause();
    p.fire("onStateChange", 2);
    t.now = 5000;
    p.currentTime = 7;
    p.fire("onStateChange", 3);
    p.fire("onStateChange", 1);
    expect(intents(events)).toEqual([{ type: "intent", playing: true, position: 7 }]);
  });

  test("a slow autoplay after our pause (load → buffering → playing) is not an intent", () => {
    const { t, adapter, p, events, ready } = setup();
    ready();
    adapter.pause();
    t.now = 1500;
    p.fire("onStateChange", -1);
    p.fire("onStateChange", 3);
    t.now = 2500;
    p.fire("onStateChange", 1);
    expect(intents(events)).toEqual([]);
  });

  test("the first play/pause after an ad is not an intent", () => {
    const { t, adapter, p, events, ready } = setup();
    ready();
    adapter.play();
    p.fire("onStateChange", 1);
    t.now = 5000;
    p.videoData = { video_id: "fake-ad-0001" };
    p.fire("onStateChange", 1);
    t.now = 20_000;
    p.videoData = { video_id: VIDEO };
    p.fire("onStateChange", 2);
    expect(intents(events)).toEqual([]);
  });

  test("echoes of our own commands are not intents", () => {
    const { t, adapter, p, events, ready } = setup();
    ready();
    adapter.play();
    t.now = 100;
    p.fire("onStateChange", 2); // odd transient right after our play()
    t.now = 300;
    p.fire("onStateChange", 1);
    adapter.seek(50);
    t.now = 900;
    p.fire("onStateChange", 3);
    p.fire("onStateChange", 2);
    expect(ECHO_WINDOW_MS).toBe(1000);
    expect(intents(events)).toEqual([]);
  });

  test("no intents before we have issued a command (autoplay at load), or while buffering/ended/in an ad", () => {
    const { t, adapter, p, events, ready } = setup();
    ready();
    t.now = 5000;
    p.fire("onStateChange", 1);
    p.fire("onStateChange", 2);
    adapter.play();
    t.now = 10_000;
    p.fire("onStateChange", 3);
    p.fire("onStateChange", 0);
    p.videoData = { video_id: "fake-ad-0001" };
    p.fire("onStateChange", 2);
    expect(intents(events)).toEqual([]);
  });

  test("autoplay blocked → mute + play, then an event for the Unmute button; the resulting play is not an intent", () => {
    const { t, adapter, p, events, ready } = setup();
    ready();
    adapter.play();
    clear(p);
    t.now = 3000;
    p.fire("onAutoplayBlocked");
    expect(p.calls).toEqual([["mute"], ["playVideo"]]);
    expect(events).toContainEqual({ type: "autoplay-blocked" });
    t.now = 3200;
    p.fire("onStateChange", 1);
    expect(intents(events)).toEqual([]);
  });

  test("errors are forwarded with their numeric code; garbage codes become -1", () => {
    const { p, events, ready } = setup();
    ready();
    p.fire("onError", 150);
    p.fire("onError", "boom");
    expect(events.filter((e) => e.type === "error")).toEqual([
      { type: "error", code: 150 },
      { type: "error", code: -1 },
    ]);
  });

  test("unsubscribe and destroy stop events and destroy the player", () => {
    const { adapter, p, events, ready } = setup();
    const extra: PlayerEvent[] = [];
    const off = adapter.onEvent((e) => extra.push(e));
    off();
    ready();
    expect(extra).toEqual([]);
    adapter.destroy();
    p.fire("onStateChange", 1);
    expect(events.filter((e) => e.type === "state")).toEqual([]);
    expect(p.calls.at(-1)).toEqual(["destroy"]);
    expect(adapter.ready()).toBe(false);
  });
});
