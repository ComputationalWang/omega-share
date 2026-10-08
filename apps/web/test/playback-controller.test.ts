import { describe, expect, test } from "bun:test";
import { playbackCaps, type ClientMessage, type PlaybackState } from "@omega/shared";
import { CATCHUP_SHOW_MS } from "../src/controls/catchup";
import { createPlaybackController, type PlaybackView } from "../src/controls/playback";
import type { PlaybackTarget } from "../src/intents";
import { SYNC_INTERVAL_MS } from "../src/sync";
import { FakePlayer, type FakePlayerOptions } from "./support/fake-player";

const VIDEO = "dQw4w9WgXcQ";
const OTHER = "9bZkp7q19f0";
const embedOf = (videoId: string) => ({ provider: "youtube", videoId, url: `https://www.youtube.com/embed/${videoId}` }) as const;
const SERVER_OFFSET = 1_000_000;

function pb(over: Partial<PlaybackState> = {}): PlaybackState {
  return { playing: true, position: 10, rate: 1, at: SERVER_OFFSET, rev: 1, action: "play", by: "b", ...over };
}

function harness(playerOpts: Omit<Partial<FakePlayerOptions>, "now"> = {}) {
  const t = { now: 0 };
  const sent: ClientMessage[] = [];
  const net = { up: true };
  const views: PlaybackView[] = [];
  const clock = { ready: true, ticks: 0, serverNow: () => t.now + SERVER_OFFSET, tick: () => {
      clock.ticks++;
    },
  };
  const timers: { fn: () => void; cleared: boolean }[] = [];
  const c = createPlaybackController({
    send: (m) => {
      if (!net.up) return false;
      sent.push(m);
      return true;
    },
    clock,
    now: () => t.now,
    setInterval: (fn) => {
      const h = { fn, cleared: false };
      timers.push(h);
      return h;
    },
    clearInterval: (h) => {
      h.cleared = true;
    },
    onView: (v) => views.push(v),
  });
  const player = new FakePlayer({ now: () => t.now, state: "cued", position: 0, duration: 212, ...playerOpts });
  const run = (ms: number) => {
    const end = t.now + ms;
    while (t.now < end) {
      t.now += SYNC_INTERVAL_MS;
      c.tick();
    }
  };
  const room = (videoId: string, playback: PlaybackState | null): PlaybackTarget => ({ embed: embedOf(videoId), playback });
  return { t, sent, net, views, clock, timers, c, player, run, room };
}

describe("personal volume is local only", () => {
  test("volume, mute and unmute never put anything on the wire", () => {
    const h = harness();
    h.c.setRoom(h.room(VIDEO, pb()));
    h.c.attach(h.player, embedOf(VIDEO).url);
    h.c.setVolume(30);
    h.c.toggleMute();
    h.c.toggleMute();
    h.player.emit({ type: "autoplay-blocked" });
    h.c.unmute();
    h.c.setVolume(80);
    expect(h.sent).toEqual([]);
    expect(h.player.calls.filter((c) => c.op === "volume" || c.op === "unmute")).toEqual([
      { op: "volume", volume: 100 },
      { op: "volume", volume: 30 },
      { op: "volume", volume: 0 },
      { op: "unmute" },
      { op: "volume", volume: 30 },
      { op: "unmute" },
      { op: "volume", volume: 30 },
      { op: "volume", volume: 80 },
    ]);
  });

  test("the volume chosen before the player is ready is applied on attach", () => {
    const h = harness();
    h.c.setVolume(25);
    h.c.setRoom(h.room(VIDEO, pb()));
    h.c.attach(h.player, embedOf(VIDEO).url);
    expect(h.player.calls).toContainEqual({ op: "volume", volume: 25 });
    expect(h.c.view()).toMatchObject({ volume: 25, muted: false });
  });

  test("a player that becomes ready later gets the volume on ready", () => {
    const h = harness({ ready: false });
    h.c.setVolume(40);
    h.c.setRoom(h.room(VIDEO, pb()));
    h.c.attach(h.player, embedOf(VIDEO).url);
    h.player.isReady = true;
    h.player.emit({ type: "ready" });
    expect(h.player.calls).toContainEqual({ op: "volume", volume: 40 });
    expect(h.sent).toEqual([]);
  });

  test("volume is clamped to 0–100", () => {
    const h = harness();
    h.c.setVolume(150);
    expect(h.c.view().volume).toBe(100);
    h.c.setVolume(-4);
    expect(h.c.view().volume).toBe(0);
  });
});

describe("shared transport sends control intents", () => {
  test("play/pause toggles the room, at the room's position on the server clock", () => {
    const h = harness();
    h.c.setRoom(h.room(VIDEO, pb({ playing: true, position: 10, at: SERVER_OFFSET })));
    h.t.now = 2000;
    expect(h.c.togglePlay()).toBe(true);
    expect(h.sent).toEqual([{ type: "control", url: embedOf(VIDEO).url, playing: false, position: 12 }]);
  });

  test("seek keeps the room's play state", () => {
    const h = harness();
    h.c.setRoom(h.room(VIDEO, pb({ playing: false })));
    expect(h.c.seek(90)).toBe(true);
    expect(h.sent).toEqual([{ type: "control", url: embedOf(VIDEO).url, playing: false, position: 90 }]);
  });

  test("nothing is sent without playback, or before the clock is synced", () => {
    const h = harness();
    expect(h.c.togglePlay()).toBe(false);
    h.c.setRoom(h.room(VIDEO, pb()));
    h.clock.ready = false;
    expect(h.c.togglePlay()).toBe(false);
    expect(h.sent).toEqual([]);
  });

  test("a play/pause the user makes inside the player becomes a control", () => {
    const h = harness();
    h.c.setRoom(h.room(VIDEO, pb()));
    h.c.attach(h.player, embedOf(VIDEO).url);
    h.player.emit({ type: "intent", playing: false, position: 33 });
    expect(h.sent).toEqual([{ type: "control", url: embedOf(VIDEO).url, playing: false, position: 33 }]);
  });
});

describe("wiring: room playback → sync loop → player", () => {
  test("a late joiner hard-seeks to the room's position and plays", () => {
    const h = harness();
    h.c.setRoom(h.room(VIDEO, pb({ playing: true, position: 10, at: SERVER_OFFSET - 5000 })));
    h.c.attach(h.player, embedOf(VIDEO).url);
    h.run(SYNC_INTERVAL_MS);
    const seek = h.player.calls.find((c) => c.op === "seek");
    expect(seek?.op === "seek" ? seek.to : -1).toBeCloseTo(15.25, 2);
    expect(h.player.calls).toContainEqual({ op: "play" });
  });

  test("a new playback state hard-seeks again", () => {
    const h = harness({ state: "playing", position: 10 });
    h.c.setRoom(h.room(VIDEO, pb({ position: 10, at: SERVER_OFFSET })));
    h.c.attach(h.player, embedOf(VIDEO).url);
    h.run(1000);
    h.player.calls.length = 0;
    h.c.setRoom(h.room(VIDEO, pb({ rev: 2, action: "seek", position: 100, at: h.t.now + SERVER_OFFSET })));
    h.run(SYNC_INTERVAL_MS);
    const seek = h.player.calls.find((c) => c.op === "seek");
    expect(seek?.op === "seek" ? seek.to : -1).toBeCloseTo(100.25, 2);
  });

  test("the same state again (a re-render) does not re-seek", () => {
    const h = harness({ state: "playing", position: 10 });
    const target = h.room(VIDEO, pb({ position: 10, at: SERVER_OFFSET }));
    h.c.setRoom(target);
    h.c.attach(h.player, embedOf(VIDEO).url);
    h.run(1000);
    h.player.calls.length = 0;
    h.c.setRoom({ ...target });
    h.run(SYNC_INTERVAL_MS);
    expect(h.player.calls.filter((c) => c.op === "seek")).toEqual([]);
  });

  test("a new embed resets: the old player is destroyed, and a stale attach is refused", () => {
    const h = harness();
    h.c.setRoom(h.room(VIDEO, pb()));
    h.c.attach(h.player, embedOf(VIDEO).url);
    expect(h.c.view().hasVideo).toBe(true);
    h.c.setRoom(h.room(OTHER, pb({ rev: 2, action: "load", position: 0 })));
    expect(h.player.destroyed).toBe(true);
    expect(h.c.view().hasVideo).toBe(false);
    const late = new FakePlayer({ now: () => h.t.now });
    h.c.attach(late, embedOf(VIDEO).url);
    expect(late.destroyed).toBe(true);
    const fresh = new FakePlayer({ now: () => h.t.now });
    h.c.attach(fresh, embedOf(OTHER).url);
    expect(fresh.destroyed).toBe(false);
    expect(h.c.view().hasVideo).toBe(true);
  });

  test("every tick also ticks the clock (sleep detection)", () => {
    const h = harness();
    h.run(SYNC_INTERVAL_MS * 3);
    expect(h.clock.ticks).toBe(3);
  });

  test("start/stop run one 4 Hz timer", () => {
    const h = harness();
    h.c.start();
    h.c.start();
    expect(h.timers).toHaveLength(1);
    h.c.stop();
    expect(h.timers[0]?.cleared).toBe(true);
  });
});

describe("view", () => {
  test("position is the room's, duration the player's; paused ticks emit nothing new", () => {
    const h = harness();
    h.c.setRoom(h.room(VIDEO, pb({ playing: false, position: 42 })));
    h.c.attach(h.player, embedOf(VIDEO).url);
    expect(h.c.view()).toMatchObject({ playing: false, position: 42, duration: 212 });
    const n = h.views.length;
    h.run(1000);
    expect(h.views.length).toBe(n);
  });

  test("autoplay blocked → needsUnmute until unmute()", () => {
    const h = harness();
    h.c.setRoom(h.room(VIDEO, pb()));
    h.c.attach(h.player, embedOf(VIDEO).url);
    h.player.emit({ type: "autoplay-blocked" });
    expect(h.c.view().needsUnmute).toBe(true);
    h.c.unmute();
    expect(h.c.view().needsUnmute).toBe(false);
  });

  test("my player buffering while the room plays → catching up; back in step → not", () => {
    const h = harness({ state: "playing", position: 10 });
    h.c.setRoom(h.room(VIDEO, pb({ position: 10, at: SERVER_OFFSET })));
    h.c.attach(h.player, embedOf(VIDEO).url);
    h.run(500);
    h.player.setState("buffering");
    h.run(CATCHUP_SHOW_MS + SYNC_INTERVAL_MS);
    expect(h.c.view().catching).toBe(true);
    h.player.setState("playing");
    h.run(SYNC_INTERVAL_MS);
    expect(h.c.view().catching).toBe(false);
  });
});

describe("review follow-ups", () => {
  test("pause after the video ended sends the duration, not a position past the end", () => {
    const h = harness({ duration: 212 });
    h.c.setRoom(h.room(VIDEO, pb({ playing: true, position: 200, at: SERVER_OFFSET })));
    h.c.attach(h.player, embedOf(VIDEO).url);
    h.t.now = 600_000;
    expect(h.c.togglePlay()).toBe(true);
    expect(h.sent).toEqual([{ type: "control", url: embedOf(VIDEO).url, playing: false, position: 212 }]);
  });

  test("play from a paused room works while the clock resyncs (no clock needed)", () => {
    const h = harness();
    h.c.setRoom(h.room(VIDEO, pb({ playing: false, position: 42 })));
    h.clock.ready = false;
    expect(h.c.view().canControl).toBe(true);
    expect(h.c.togglePlay()).toBe(true);
    expect(h.sent).toEqual([{ type: "control", url: embedOf(VIDEO).url, playing: true, position: 42 }]);
  });

  test("pausing a playing room waits for the clock, and the key says so (canControl false)", () => {
    const h = harness();
    h.c.setRoom(h.room(VIDEO, pb({ playing: true })));
    h.clock.ready = false;
    h.run(SYNC_INTERVAL_MS);
    expect(h.c.view().canControl).toBe(false);
    h.clock.ready = true;
    h.run(SYNC_INTERVAL_MS);
    expect(h.c.view().canControl).toBe(true);
  });

  test("after a blocked autoplay, the mute key unmutes (and clears Unmute) instead of muting", () => {
    const h = harness();
    h.c.setRoom(h.room(VIDEO, pb()));
    h.c.attach(h.player, embedOf(VIDEO).url);
    h.player.emit({ type: "autoplay-blocked" });
    h.player.calls.length = 0;
    h.c.toggleMute();
    expect(h.c.view()).toMatchObject({ muted: false, needsUnmute: false });
    expect(h.player.calls).toEqual([{ op: "unmute" }, { op: "volume", volume: 100 }]);
    expect(h.sent).toEqual([]);
  });

  test("after a blocked autoplay, moving the volume unmutes too", () => {
    const h = harness();
    h.c.setRoom(h.room(VIDEO, pb()));
    h.c.attach(h.player, embedOf(VIDEO).url);
    h.player.emit({ type: "autoplay-blocked" });
    h.player.calls.length = 0;
    h.c.setVolume(60);
    expect(h.c.view().needsUnmute).toBe(false);
    expect(h.player.calls).toEqual([{ op: "unmute" }, { op: "volume", volume: 60 }]);
  });

  test("while playing, the view changes once per second, not every tick", () => {
    const h = harness({ state: "playing", position: 10 });
    h.c.setRoom(h.room(VIDEO, pb({ position: 10, at: SERVER_OFFSET })));
    h.c.attach(h.player, embedOf(VIDEO).url);
    h.run(1000);
    const n = h.views.length;
    h.run(4000);
    expect(h.views.length - n).toBeLessThanOrEqual(5);
    expect(Number.isInteger(h.c.view().position)).toBe(true);
  });
});

describe("YouTube refuses the video (OME-110)", () => {
  test("error 150 → the view carries the code and stops claiming the room plays here", () => {
    const h = harness({ state: "playing", position: 10 });
    h.c.setRoom(h.room(VIDEO, pb()));
    h.c.attach(h.player, embedOf(VIDEO).url);
    expect(h.c.view()).toMatchObject({ playing: true, canControl: true, error: null });
    h.player.emit({ type: "error", reason: "refused", code: "150" });
    expect(h.c.view()).toMatchObject({ error: { reason: "refused", code: "150" }, playing: false, canControl: false, hasVideo: false, position: 0, catching: false });
    expect(h.views.at(-1)?.error).toEqual({ reason: "refused", code: "150" });
  });

  test("after an error the transport sends nothing and the view stays frozen", () => {
    const h = harness({ state: "playing", position: 10 });
    h.c.setRoom(h.room(VIDEO, pb()));
    h.c.attach(h.player, embedOf(VIDEO).url);
    h.player.emit({ type: "error", reason: "refused", code: "101" });
    const n = h.views.length;
    h.run(3000);
    expect(h.views.length).toBe(n);
    expect(h.c.togglePlay()).toBe(false);
    expect(h.c.seek(30)).toBe(false);
    expect(h.sent).toEqual([]);
  });

  test("the sync loop stops commanding the refused player", () => {
    const h = harness({ state: "playing", position: 10 });
    h.c.setRoom(h.room(VIDEO, pb()));
    h.c.attach(h.player, embedOf(VIDEO).url);
    h.run(1000);
    h.player.emit({ type: "error", reason: "refused", code: "150" });
    const n = h.player.calls.length;
    h.c.setRoom(h.room(VIDEO, pb({ rev: 2, position: 50 })));
    h.run(3000);
    expect(h.player.calls.length).toBe(n);
  });

  test("a new video clears the error", () => {
    const h = harness();
    h.c.setRoom(h.room(VIDEO, pb()));
    h.c.attach(h.player, embedOf(VIDEO).url);
    h.player.emit({ type: "error", reason: "not-found", code: "100" });
    expect(h.c.view().error).toEqual({ reason: "not-found", code: "100" });
    h.c.setRoom(h.room(OTHER, pb({ rev: 2 })));
    expect(h.c.view().error).toBeNull();
  });
});

const LIVE = { provider: "twitch", kind: "live", channel: "some_streamer", url: "https://player.twitch.tv/?channel=some_streamer" } as const;
const VOD = { provider: "twitch", kind: "vod", videoId: "1234567890", url: "https://player.twitch.tv/?video=v1234567890" } as const;

describe("live embeds (Twitch live, OME-125)", () => {
  const live = (over: Partial<PlaybackState> = {}) => {
    const h = harness({ caps: playbackCaps(LIVE), rates: [1], duration: 0, state: "playing" });
    h.c.setRoom({ embed: LIVE, playback: pb(over) });
    return h;
  };

  test("the view says live and which provider; no position or duration", () => {
    const h = live();
    h.t.now = 60_000;
    expect(h.c.view()).toMatchObject({ live: true, provider: "twitch", seekOnly: false, position: 0, duration: 0 });
  });

  test("seek is refused: nothing is sent", () => {
    const h = live({ playing: false });
    expect(h.c.seek(30)).toBe(false);
    expect(h.sent).toEqual([]);
  });

  test("pause and play-from-live are shared, even before the server clock is synced", () => {
    const h = live({ playing: true });
    h.clock.ready = false;
    expect(h.c.view().canControl).toBe(true);
    expect(h.c.togglePlay()).toBe(true);
    expect(h.sent).toEqual([{ type: "control", url: LIVE.url, playing: false, position: 0 }]);
  });

  test("a late joiner to a playing live room plays (= the live edge) and never seeks", () => {
    const h = harness({ caps: playbackCaps(LIVE), rates: [1], duration: 0, state: "cued" });
    h.c.setRoom({ embed: LIVE, playback: pb({ playing: true, position: 5000, at: SERVER_OFFSET - 3_600_000 }) });
    h.c.attach(h.player, LIVE.url);
    h.run(2000);
    expect(h.player.calls.some((c) => c.op === "play")).toBe(true);
    expect(h.player.calls.some((c) => c.op === "seek" || c.op === "rate")).toBe(false);
  });
});

describe("provider plate and seek-only hint in the view", () => {
  test("YouTube: fine sync, no hint; Twitch VOD: seek-only", () => {
    const h = harness();
    h.c.setRoom(h.room(VIDEO, pb()));
    expect(h.c.view()).toMatchObject({ live: false, provider: "youtube", seekOnly: false });
    h.c.setRoom({ embed: VOD, playback: pb({ rev: 2 }) });
    expect(h.c.view()).toMatchObject({ live: false, provider: "twitch", seekOnly: true });
    h.c.setRoom({ embed: null, playback: null });
    expect(h.c.view()).toMatchObject({ live: false, provider: null, seekOnly: false });
  });

  test("Vimeo whose rate probe was rejected: the hint shows once the loop falls back to seek-only", () => {
    const vimeo = { provider: "vimeo", videoId: "76979871", hash: null, url: "https://player.vimeo.com/video/76979871" } as const;
    const h = harness({ caps: playbackCaps(vimeo), rates: [1], state: "playing" });
    h.c.setRoom({ embed: vimeo, playback: pb() });
    expect(h.c.view()).toMatchObject({ provider: "vimeo", seekOnly: false });
    h.c.attach(h.player, vimeo.url);
    h.run(SYNC_INTERVAL_MS);
    expect(h.c.view()).toMatchObject({ provider: "vimeo", seekOnly: true });
  });

  test("Vimeo whose rate probe succeeded: no hint", () => {
    const vimeo = { provider: "vimeo", videoId: "76979871", hash: null, url: "https://player.vimeo.com/video/76979871" } as const;
    const h = harness({ caps: playbackCaps(vimeo), rates: [0.5, 0.75, 1, 1.25, 1.5, 2], state: "playing" });
    h.c.setRoom({ embed: vimeo, playback: pb() });
    h.c.attach(h.player, vimeo.url);
    h.run(SYNC_INTERVAL_MS);
    expect(h.c.view()).toMatchObject({ provider: "vimeo", seekOnly: false });
  });
});

describe("an offline channel clears itself (research M2 §2.1)", () => {
  test("offline shows the notice and stops driving the player; the next state event clears it and sync resumes", () => {
    const h = harness({ caps: playbackCaps(LIVE), rates: [1], duration: 0, state: "paused" });
    h.c.setRoom({ embed: LIVE, playback: pb({ playing: true }) });
    h.c.attach(h.player, LIVE.url);
    h.player.emit({ type: "error", reason: "offline", code: "offline" });
    expect(h.c.view().error).toEqual({ reason: "offline", code: "offline" });
    h.player.calls.length = 0;
    h.run(2000);
    expect(h.player.calls).toEqual([]);
    h.player.emit({ type: "state", state: "paused" });
    expect(h.c.view().error).toBeNull();
    h.run(1000);
    expect(h.player.calls).toContainEqual({ op: "play" });
  });

  test("a refusal is not cleared by a later state event", () => {
    const h = harness({ state: "playing" });
    h.c.setRoom(h.room(VIDEO, pb()));
    h.c.attach(h.player, embedOf(VIDEO).url);
    h.player.emit({ type: "error", reason: "refused", code: "150" });
    h.player.emit({ type: "state", state: "playing" });
    expect(h.c.view().error).toEqual({ reason: "refused", code: "150" });
  });
});

describe("my catching-up status goes to the room (OME-214, ADR 0019)", () => {
  const statuses = (sent: readonly ClientMessage[]) => sent.filter((m) => m.type === "status");
  const catchingHarness = () => {
    const h = harness({ state: "playing", position: 10 });
    h.c.setRoom(h.room(VIDEO, pb({ position: 10, at: SERVER_OFFSET })));
    h.c.attach(h.player, embedOf(VIDEO).url);
    h.run(500);
    return h;
  };

  test("sends status only when catching changes: once on, once off", () => {
    const h = catchingHarness();
    h.player.setState("buffering");
    h.run(CATCHUP_SHOW_MS + SYNC_INTERVAL_MS);
    expect(statuses(h.sent)).toEqual([{ type: "status", catching: true }]);
    h.run(5 * SYNC_INTERVAL_MS);
    expect(statuses(h.sent)).toHaveLength(1);
    h.player.setState("playing");
    h.run(5 * SYNC_INTERVAL_MS);
    expect(statuses(h.sent)).toEqual([
      { type: "status", catching: true },
      { type: "status", catching: false },
    ]);
  });

  test("a stall shorter than CATCHUP_SHOW_MS sends nothing", () => {
    const h = catchingHarness();
    h.player.setState("buffering");
    h.run(SYNC_INTERVAL_MS);
    h.player.setState("playing");
    h.run(CATCHUP_SHOW_MS * 2);
    expect(statuses(h.sent)).toEqual([]);
  });

  test("a send that didn't go out is retried on a later tick", () => {
    const h = catchingHarness();
    h.net.up = false;
    h.player.setState("buffering");
    h.run(CATCHUP_SHOW_MS + SYNC_INTERVAL_MS);
    expect(statuses(h.sent)).toEqual([]);
    h.net.up = true;
    h.run(SYNC_INTERVAL_MS);
    expect(statuses(h.sent)).toEqual([{ type: "status", catching: true }]);
  });

  test("after a fresh join the server knows nothing, so a catching client says so again", () => {
    const h = catchingHarness();
    h.player.setState("buffering");
    h.run(CATCHUP_SHOW_MS + SYNC_INTERVAL_MS);
    h.c.joined();
    h.run(SYNC_INTERVAL_MS);
    expect(statuses(h.sent)).toEqual([
      { type: "status", catching: true },
      { type: "status", catching: true },
    ]);
  });

  test("a fresh join while not catching sends nothing", () => {
    const h = catchingHarness();
    h.c.joined();
    h.run(SYNC_INTERVAL_MS * 4);
    expect(statuses(h.sent)).toEqual([]);
  });
});

describe("a new room state reaches the player at once (OME-452)", () => {
  test("a resume plays as the room state arrives, not on the next tick, so clients don't lag by their tick phase", () => {
    const h = harness({ state: "paused", position: 10 });
    h.c.start();
    h.c.setRoom(h.room(VIDEO, pb({ playing: false, action: "pause", position: 10, at: SERVER_OFFSET })));
    h.c.attach(h.player, embedOf(VIDEO).url);
    h.run(SYNC_INTERVAL_MS * 2);
    h.player.calls.length = 0;
    // The resume lands 240 ms into this client's tick phase.
    h.t.now += 240;
    h.c.setRoom(h.room(VIDEO, pb({ rev: 2, position: 10, at: h.clock.serverNow() })));
    expect(h.player.calls.map((c) => c.op)).toContain("play");
  });

  test("before start() a room state waits for the timer", () => {
    const h = harness({ state: "paused", position: 10 });
    h.c.setRoom(h.room(VIDEO, pb({ playing: false, action: "pause", position: 10, at: SERVER_OFFSET })));
    h.c.attach(h.player, embedOf(VIDEO).url);
    h.player.calls.length = 0;
    h.c.setRoom(h.room(VIDEO, pb({ rev: 2, position: 10, at: h.clock.serverNow() })));
    expect(h.player.calls.map((c) => c.op)).not.toContain("play");
  });
});
