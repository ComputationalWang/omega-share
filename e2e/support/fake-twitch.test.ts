// Self-tests for the fake Twitch Embed/Player SDK (OME-121). Real time, no fake clocks: the fake is performance.now()-driven.
import { expect, test } from "bun:test";
import { installFakeTwitch } from "../fixtures/fake-twitch-embed";
import type {
  ElementLike,
  FakeTwitchConfig,
  FakeTwitchEventName,
  FakeTwitchHooks,
  FakeTwitchHost,
  FakeTwitchNamespace,
  FakeTwitchPlayer,
  TwitchPlayerOptions,
} from "../fixtures/fake-twitch-embed";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

class El implements ElementLike {
  nodeType = 1;
  attrs = new Map<string, string>();
  children: ElementLike[] = [];
  constructor(public tagName: string, public id = "") {}
  setAttribute(name: string, value: string) { this.attrs.set(name, value); }
  getAttribute(name: string) { return this.attrs.get(name) ?? null; }
  appendChild(child: ElementLike) { this.children.push(child); return child; }
}

interface HostOpts {
  domain?: string;
  storage?: "both" | "one" | "none";
}

function makeHost(opts: HostOpts = {}): { host: FakeTwitchHost; target: El } {
  const target = new El("DIV", "player");
  const fn = () => undefined;
  const storage = opts.storage ?? "none";
  const host: FakeTwitchHost = {
    performance,
    setTimeout: (h, ms) => setTimeout(h, ms),
    clearTimeout: (id) => { clearTimeout(id as ReturnType<typeof setTimeout>); },
    document: {
      domain: opts.domain ?? "omega.test",
      location: { href: "http://omega.test/room" },
      getElementById: (id) => (id === "player" ? target : null),
      createElement: () => new El("IFRAME"),
      ...(storage === "both" ? { hasStorageAccess: fn, requestStorageAccess: fn } : {}),
      ...(storage === "one" ? { hasStorageAccess: fn } : {}),
    },
  };
  installFakeTwitch(host);
  return { host, target };
}

interface Rig {
  Twitch: FakeTwitchNamespace;
  hooks: FakeTwitchHooks;
  player: FakeTwitchPlayer;
  target: El;
  types(): string[];
}

function parts(host: FakeTwitchHost): { Twitch: FakeTwitchNamespace; hooks: FakeTwitchHooks } {
  const { Twitch, __fakeTwitch: hooks } = host;
  if (!Twitch || !hooks) throw new Error("fake did not install Twitch and __fakeTwitch");
  return { Twitch, hooks };
}

async function rig(options: TwitchPlayerOptions = { video: "v123" }, config: Partial<FakeTwitchConfig> = {}): Promise<Rig> {
  const { host, target } = makeHost();
  const { Twitch, hooks } = parts(host);
  hooks.configure(config);
  const player = new Twitch.Player("player", options);
  await new Promise<void>((r) => { player.addEventListener(Twitch.Player.READY, () => { r(); }); });
  return { Twitch, hooks, player, target, types: () => hooks.events.map((e) => e.type) };
}

const from = (r: Rig, n: number) => r.types().slice(n);

test("install defines Twitch.Player and Twitch.Embed with the SDK's exact event constants and error enum", () => {
  const { Twitch } = parts(makeHost().host);
  const constants = {
    AUTHENTICATE: "authenticate", CAPTIONS: "captions", ENDED: "ended", ERROR: "error", OFFLINE: "offline", ONLINE: "online",
    PAUSE: "pause", PLAY: "play", PLAYBACK_BLOCKED: "playbackBlocked", PLAYING: "playing", VIDEO_PAUSE: "video.pause",
    VIDEO_PLAY: "video.play", VIDEO_READY: "video.ready", READY: "ready", SEEK: "seek",
  } as const;
  for (const k of Object.keys(constants) as (keyof typeof constants)[]) {
    expect(Twitch.Player[k]).toBe(constants[k]);
    expect(Twitch.Embed[k]).toBe(constants[k]);
  }
  expect(Twitch.Player.Errors).toEqual({ ABORTED: 1000, NETWORK: 2000, DECODE: 3000, FORMAT_NOT_SUPPORTED: 4000, CONTENT_NOT_AVAILABLE: 5000, RENDERER_NOT_AVAILABLE: 6000 });
});

test("constructor throws without an element or without channel/video/collection; accepts an element", () => {
  const { host, target } = makeHost();
  const { Twitch } = parts(host);
  expect(() => new Twitch.Player("missing", { video: "1" })).toThrow();
  expect(() => new Twitch.Player("player", {})).toThrow();
  expect(() => new Twitch.Player("player", { width: 10 })).toThrow();
  expect(() => new Twitch.Player(target, { collection: "c" })).not.toThrow();
});

test("iframe src: sorted keys, repeated parent with the page domain appended, referrer, undefined skipped", () => {
  const { host, target } = makeHost();
  const { Twitch, hooks } = parts(host);
  new Twitch.Player("player", { video: "v123", parent: "a.com", autoplay: false, muted: true, width: 640, height: "360", time: undefined });
  expect(hooks.iframe?.getAttribute("src")).toBe(
    "https://player.twitch.tv?autoplay=false&height=360&muted=true&parent=a.com&parent=omega.test&referrer=http%3A%2F%2Fomega.test%2Froom&video=v123&width=640",
  );
  expect(target.children[0]).toBe(hooks.iframe);
  expect(hooks.options).toEqual({ video: "v123", parent: "a.com", autoplay: false, muted: true, width: 640, height: "360", time: undefined });
});

test("parent defaults to the page domain and is not duplicated when already listed", () => {
  const { host } = makeHost();
  const { Twitch, hooks } = parts(host);
  new Twitch.Player("player", { channel: "chan" });
  expect(hooks.iframe?.getAttribute("src")).toBe("https://player.twitch.tv?channel=chan&parent=omega.test&referrer=http%3A%2F%2Fomega.test%2Froom");
  new Twitch.Player("player", { channel: "chan", parent: ["omega.test", "b.com"] });
  expect(hooks.iframe?.getAttribute("src")).toBe("https://player.twitch.tv?channel=chan&parent=omega.test&parent=b.com&referrer=http%3A%2F%2Fomega.test%2Froom");
});

test("iframe attributes match the SDK; storage-access token only when both document functions exist", () => {
  const base = "allow-modals allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox";
  const iframeFor = (storage: HostOpts["storage"], options: TwitchPlayerOptions) => {
    const { host } = makeHost({ storage });
    const { Twitch, hooks } = parts(host);
    new Twitch.Player("player", options);
    if (!hooks.iframe) throw new Error("no iframe");
    return hooks.iframe;
  };
  const f = iframeFor("none", { video: "1", width: 640, height: 360 });
  expect(f.getAttribute("allowfullscreen")).toBe("");
  expect(f.getAttribute("scrolling")).toBe("no");
  expect(f.getAttribute("frameborder")).toBe("0");
  expect(f.getAttribute("allow")).toBe("autoplay; fullscreen");
  expect(f.getAttribute("title")).toBe("Twitch");
  expect(f.getAttribute("sandbox")).toBe(base);
  expect(f.getAttribute("width")).toBe("640");
  expect(f.getAttribute("height")).toBe("360");
  expect(iframeFor("both", { video: "1" }).getAttribute("sandbox")).toBe(`${base} allow-storage-access-by-user-activation`);
  expect(iframeFor("one", { video: "1" }).getAttribute("sandbox")).toBe(base);
  expect(iframeFor("none", { video: "1" }).getAttribute("width")).toBeNull();
});

test("READY fires asynchronously with playback Ready; commands before READY are dropped and recorded", async () => {
  const { host } = makeHost();
  const { Twitch, hooks } = parts(host);
  const player = new Twitch.Player("player", { video: "v1" });
  player.play();
  player.setMuted(true);
  expect(hooks.events).toEqual([]);
  expect(hooks.playback).toBe("Idle");
  expect(player.getMuted()).toBe(false);
  expect(hooks.commands.map((c) => [c.name, c.dropped])).toEqual([["play", true], ["setMuted", true]]);
  expect(hooks.commands[1]?.args).toEqual([true]);
  await sleep(60);
  expect(hooks.events.map((e) => e.type)).toEqual(["ready"]);
  expect(hooks.playback).toBe("Ready");
  expect(player.getPlayerState().playback).toBe("Ready");
  expect(player.getPlayerState().videoID).toBe("v1");
  expect(player.getDuration()).toBe(3600);
  expect(player.isPaused()).toBe(false);
  player.play();
  expect(hooks.commands[2]?.dropped).toBe(false);
  expect(hooks.playback).toBe("Playing");
});

test("media clock advances at 1x within 2% over ~1 s", async () => {
  const r = await rig();
  r.player.play();
  const t0 = performance.now();
  await sleep(1000);
  const media = r.hooks.currentTime;
  const wall = (performance.now() - t0) / 1000;
  expect(Math.abs(media / wall - 1)).toBeLessThan(0.02);
});

test("cached currentTime is stale between pushes and catches up on the push timer and on commands", async () => {
  const r = await rig({ video: "v" }, { pushIntervalMs: 100000 });
  r.player.play();
  await sleep(300);
  expect(r.player.getCurrentTime()).toBe(0);
  expect(r.hooks.currentTime).toBeGreaterThan(0.28);
  r.player.pause();
  expect(r.player.getCurrentTime()).toBeGreaterThan(0.28);
  const r2 = await rig({ video: "v" }, { pushIntervalMs: 120 });
  r2.player.play();
  await sleep(430);
  const cached = r2.player.getCurrentTime();
  expect(cached).toBeGreaterThan(0.3);
  expect(r2.hooks.currentTime - cached).toBeLessThan(0.13);
});

test("push interval is settable after the player exists", async () => {
  const r = await rig({ video: "v" }, { pushIntervalMs: 100000 });
  r.player.play();
  r.hooks.configure({ pushIntervalMs: 50 });
  await sleep(200);
  expect(r.player.getCurrentTime()).toBeGreaterThan(0.1);
});

test("play, pause, seek event sequences on a VOD; seek clamps and keeps the play/pause state", () => {
  return rig().then((r) => {
    expect(r.types()).toEqual(["ready"]);
    r.player.play();
    expect(from(r, 1)).toEqual(["play", "playing"]);
    expect(r.player.getPlayerState().playback).toBe("Playing");
    r.player.seek(100);
    expect(from(r, 3)).toEqual(["seek"]);
    expect(r.hooks.playback).toBe("Playing");
    expect(r.player.getCurrentTime()).toBeCloseTo(100, 0);
    r.player.pause();
    expect(from(r, 4)).toEqual(["pause"]);
    expect(r.player.isPaused()).toBe(true);
    r.player.seek(99999);
    expect(from(r, 5)).toEqual(["seek"]);
    expect(r.hooks.playback).toBe("Idle");
    expect(r.player.getCurrentTime()).toBe(3600);
    r.player.seek(-5);
    expect(r.player.getCurrentTime()).toBe(0);
    expect(r.hooks.commands.map((c) => c.name)).toEqual(["play", "seek", "pause", "seek", "seek"]);
  });
});

test("ENDED at the duration: playback Ended, ended true, time pinned at duration", async () => {
  const r = await rig({ video: "v" }, { duration: 0.3 });
  r.player.play();
  await sleep(450);
  expect(from(r, 1)).toEqual(["play", "playing", "ended"]);
  expect(r.player.getPlayerState().playback).toBe("Ended");
  expect(r.player.getEnded()).toBe(true);
  expect(r.player.getCurrentTime()).toBeCloseTo(0.3, 2);
  expect(r.hooks.currentTime).toBeCloseTo(0.3, 2);
  r.player.play();
  expect(r.player.getEnded()).toBe(false);
  expect(r.hooks.currentTime).toBeLessThan(0.1);
});

test("getters mirror the cached state object; there is no rate setter", async () => {
  const r = await rig({ channel: "somechan" });
  expect(r.player.getChannel()).toBe("somechan");
  expect(r.player.getVideo()).toBe("");
  r.player.setVolume(0.4);
  r.player.setMuted(true);
  expect(r.player.getVolume()).toBe(0.4);
  expect(r.player.getMuted()).toBe(true);
  const st = r.player.getPlayerState();
  expect(st.channelName).toBe("somechan");
  expect(st.volume).toBe(0.4);
  expect(st.stats.videoStats.playbackRate).toBe(1);
  expect(r.player.getPlaybackStats()).toEqual(st.stats);
  expect("setPlaybackRate" in r.player).toBe(false);
});

test("live: time and duration are 0, seek is recorded but ignored, resume after pause emits PLAY, SEEK, PLAYING", async () => {
  const r = await rig({ channel: "chan" });
  r.player.play();
  await sleep(150);
  expect(r.player.getCurrentTime()).toBe(0);
  expect(r.player.getDuration()).toBe(0);
  expect(r.hooks.currentTime).toBe(0);
  const n = r.types().length;
  r.player.seek(50);
  expect(r.types().length).toBe(n);
  expect(r.hooks.commands.at(-1)).toMatchObject({ name: "seek", args: [50], dropped: false });
  r.player.pause();
  r.player.play();
  expect(from(r, 1)).toEqual(["play", "playing", "pause", "play", "seek", "playing"]);
});

test("buffering: playback Buffering, clock frozen, no event, then back to Playing", async () => {
  const r = await rig();
  r.player.play();
  await sleep(100);
  const n = r.types().length;
  r.hooks.buffering(200);
  expect(r.hooks.playback).toBe("Buffering");
  expect(r.player.getPlayerState().playback).toBe("Buffering");
  const t = r.hooks.currentTime;
  await sleep(100);
  expect(r.hooks.currentTime).toBe(t);
  await sleep(150);
  expect(r.hooks.playback).toBe("Playing");
  expect(r.types().length).toBe(n);
  await sleep(100);
  expect(r.hooks.currentTime).toBeGreaterThan(t + 0.05);
});

test("ad: playback stays Playing, true and cached time frozen, no event, then resumes", async () => {
  const r = await rig({ video: "v" }, { pushIntervalMs: 30 });
  r.player.play();
  await sleep(100);
  const n = r.types().length;
  r.hooks.ad(200);
  const t = r.hooks.currentTime;
  await sleep(120);
  expect(r.hooks.playback).toBe("Playing");
  expect(r.hooks.currentTime).toBe(t);
  expect(r.player.getCurrentTime()).toBe(t);
  await sleep(200);
  expect(r.types().length).toBe(n);
  await sleep(100);
  expect(r.hooks.currentTime).toBeGreaterThan(t + 0.05);
});

test("offline halts the clock and emits OFFLINE; online emits ONLINE", async () => {
  const r = await rig({ video: "v" });
  r.player.play();
  await sleep(80);
  r.hooks.offline();
  const t = r.hooks.currentTime;
  await sleep(80);
  expect(r.hooks.currentTime).toBe(t);
  r.hooks.online();
  await sleep(80);
  expect(r.hooks.currentTime).toBeGreaterThan(t + 0.05);
  expect(from(r, 3)).toEqual(["offline", "online"]);
});

test("playbackBlocked: unmuted play is refused with PLAYBACK_BLOCKED, muted play works, allowAutoplay lifts it", async () => {
  const r = await rig();
  r.player.play();
  r.hooks.playbackBlocked();
  expect(r.hooks.playback).toBe("Idle");
  expect(r.types().at(-1)).toBe("playbackBlocked");
  const n = r.types().length;
  r.player.play();
  expect(r.hooks.playback).toBe("Idle");
  expect(r.types().length).toBe(n + 1);
  expect(r.types().at(-1)).toBe("playbackBlocked");
  r.player.setMuted(true);
  r.player.play();
  expect(r.hooks.playback).toBe("Playing");
  r.player.pause();
  r.hooks.allowAutoplay();
  r.player.setMuted(false);
  r.player.play();
  expect(r.hooks.playback).toBe("Playing");
});

test("error(code) emits ERROR with the code object and halts the clock", async () => {
  const r = await rig();
  const got: unknown[] = [];
  r.player.addEventListener(r.Twitch.Player.ERROR, (p) => { got.push(p); });
  r.player.play();
  await sleep(60);
  r.hooks.error(5000);
  const t = r.hooks.currentTime;
  await sleep(60);
  expect(r.hooks.currentTime).toBe(t);
  expect(r.hooks.events.at(-1)).toMatchObject({ type: "error", params: { code: 5000 } });
  expect(got).toEqual([{ code: 5000 }]);
});

test("neverReady: READY never fires for players created afterwards, nor for one that is not yet ready", async () => {
  const { host } = makeHost();
  const { Twitch, hooks } = parts(host);
  hooks.neverReady();
  const p = new Twitch.Player("player", { video: "v" });
  await sleep(80);
  expect(hooks.events).toEqual([]);
  p.play();
  expect(hooks.commands[0]?.dropped).toBe(true);

  const o = parts(makeHost().host);
  o.hooks.configure({ readyDelayMs: 60 });
  new o.Twitch.Player("player", { video: "v" });
  o.hooks.neverReady();
  await sleep(120);
  expect(o.hooks.events).toEqual([]);
});

test("seekLatency: the seek buffers for the latency, then settles to the previous state and emits SEEK", async () => {
  const r = await rig();
  r.player.play();
  r.hooks.seekLatency(150);
  r.player.seek(100);
  expect(r.hooks.playback).toBe("Buffering");
  expect(r.types()).not.toContain("seek");
  await sleep(220);
  expect(r.hooks.playback).toBe("Playing");
  expect(r.types().at(-1)).toBe("seek");
  expect(r.hooks.currentTime).toBeGreaterThan(100);
  expect(r.hooks.currentTime).toBeLessThan(100.3);
});

test("userPause / userPlay / userSeek emit the same events but are not recorded as commands", async () => {
  const r = await rig();
  r.player.play();
  const commands = r.hooks.commands.length;
  r.hooks.userPause();
  expect(r.types().at(-1)).toBe("pause");
  expect(r.hooks.playback).toBe("Idle");
  r.hooks.userSeek(30);
  expect(r.types().at(-1)).toBe("seek");
  expect(r.player.getCurrentTime()).toBe(30);
  r.hooks.playbackBlocked();
  r.hooks.userPlay();
  expect(r.hooks.playback).toBe("Playing");
  expect(r.types().slice(-2)).toEqual(["play", "playing"]);
  expect(r.hooks.commands.length).toBe(commands);
});

test("removeEventListener stops delivery", async () => {
  const r = await rig();
  let calls = 0;
  const cb = () => { calls += 1; };
  const name: FakeTwitchEventName = r.Twitch.Player.PLAY;
  r.player.addEventListener(name, cb);
  r.player.play();
  expect(calls).toBe(1);
  r.player.pause();
  r.player.removeEventListener(name, cb);
  r.player.play();
  expect(calls).toBe(1);
});

test("destroy stops timers, events and the hook's player", async () => {
  const r = await rig({ video: "v" }, { duration: 0.2, pushIntervalMs: 30 });
  r.player.play();
  await sleep(50);
  r.player.destroy();
  const n = r.hooks.events.length;
  const cached = r.player.getCurrentTime();
  await sleep(300);
  expect(r.hooks.events.length).toBe(n);
  expect(r.player.getCurrentTime()).toBe(cached);
  expect(r.hooks.player).toBeNull();
  r.player.play();
  expect(r.hooks.events.length).toBe(n);
});
