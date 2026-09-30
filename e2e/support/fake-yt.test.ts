// Self-tests for the fake YouTube IFrame API (OME-85). Real time, no fake clocks: the fake is performance.now()-driven.
import { expect, test } from "bun:test";
import { installFakeYt } from "../fixtures/fake-iframe-api";
import type { FakePlayer, FakeYtHooks, FakeYtHost, FakeYtNamespace, FrameLike } from "../fixtures/fake-iframe-api";

const VIDEO = "aqz-KE-bpKQ";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Rig {
  YT: FakeYtNamespace;
  hooks: FakeYtHooks;
  player: FakePlayer;
  states: number[];
  rates: number[];
  errors: number[];
  blocked: number;
}

function install(onApiReady?: () => void): FakeYtHost {
  const host: FakeYtHost = { performance, setTimeout: (fn, ms) => setTimeout(fn, ms) };
  if (onApiReady) host.onYouTubeIframeAPIReady = onApiReady;
  installFakeYt(host);
  return host;
}

async function rig(): Promise<Rig> {
  const host = install();
  const { YT, __fakeYt: hooks } = host;
  if (!YT || !hooks) throw new Error("fake did not install YT and __fakeYt");
  const frame: FrameLike = { tagName: "IFRAME", src: `https://www.youtube.com/embed/${VIDEO}?enablejsapi=1&origin=http://localhost` };
  let markReady: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => { markReady = resolve; });
  const player = new YT.Player(frame, {
    events: {
      onReady: () => { markReady(); },
      onStateChange: (e) => r.states.push(e.data),
      onPlaybackRateChange: (e) => r.rates.push(e.data),
      onError: (e) => r.errors.push(e.data),
      onAutoplayBlocked: () => { r.blocked += 1; },
    },
  });
  const r: Rig = { YT, hooks, player, states: [], rates: [], errors: [], blocked: 0 };
  await ready;
  return r;
}

/** Media seconds per wall second over `ms`, measured with the same clock the fake claims to honour. */
async function slope(player: FakePlayer, ms: number): Promise<number> {
  const t0 = performance.now();
  const m0 = player.getCurrentTime();
  await sleep(ms);
  const t1 = performance.now();
  const m1 = player.getCurrentTime();
  return (m1 - m0) / ((t1 - t0) / 1000);
}

test("loader defines YT like the real iframe_api and calls onYouTubeIframeAPIReady once", () => {
  let calls = 0;
  const host = install(() => { calls += 1; });
  expect(calls).toBe(1);
  expect(host.YT?.loaded).toBe(1);
  expect(host.YT?.PlayerState).toEqual({ UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 });
  expect(typeof host.__fakeYt?.buffering).toBe("function");
});

test("onReady fires asynchronously; video data comes from the iframe src", async () => {
  const { player, hooks } = await rig();
  expect(player.getVideoData().video_id).toBe(VIDEO);
  expect(player.getDuration()).toBeCloseTo(634.5, 3);
  expect(player.getPlayerState()).toBe(-1);
  expect(player.getCurrentTime()).toBe(0);
  expect(hooks.player).toBe(player);
  expect(hooks.events[0]?.type).toBe("ready");
});

test("media clock advances at rate 1 within ±1%", async () => {
  const { player, states } = await rig();
  player.playVideo();
  expect(states).toEqual([1]);
  expect(Math.abs((await slope(player, 1000)) - 1)).toBeLessThan(0.01);
});

test("media clock honours setPlaybackRate within ±1% and emits onPlaybackRateChange", async () => {
  const { player, rates, hooks } = await rig();
  player.setPlaybackRate(1.05);
  player.setPlaybackRate(1.05);
  expect(rates).toEqual([1.05]);
  expect(player.getPlaybackRate()).toBe(1.05);
  expect(hooks.rate).toBe(1.05);
  player.playVideo();
  expect(Math.abs((await slope(player, 1000)) / 1.05 - 1)).toBeLessThan(0.01);
  player.setPlaybackRate(0.5);
  expect(Math.abs((await slope(player, 600)) / 0.5 - 1)).toBeLessThan(0.01);
});

test("rates: available list, clamping, documented round-down when fine rates are off", async () => {
  const { player, hooks } = await rig();
  expect(player.getAvailablePlaybackRates()).toEqual([0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]);
  player.setPlaybackRate(5);
  expect(player.getPlaybackRate()).toBe(2);
  hooks.configure({ fineRates: false });
  player.setPlaybackRate(1.05);
  expect(player.getPlaybackRate()).toBe(1);
  player.setPlaybackRate(0.6);
  expect(player.getPlaybackRate()).toBe(0.75);
  player.setPlaybackRate(1.6);
  expect(player.getPlaybackRate()).toBe(1.5);
});

test("applyRate:false echoes the rate but the clock stays at 1 (effective-rate trap)", async () => {
  const { player, hooks } = await rig();
  hooks.configure({ applyRate: false });
  player.setPlaybackRate(1.25);
  expect(player.getPlaybackRate()).toBe(1.25);
  player.playVideo();
  expect(Math.abs((await slope(player, 600)) - 1)).toBeLessThan(0.01);
});

test("pause emits 2 and freezes the clock; read-outs match the player", async () => {
  const { player, states, hooks } = await rig();
  player.playVideo();
  await sleep(100);
  player.pauseVideo();
  const t = player.getCurrentTime();
  await sleep(100);
  expect(player.getCurrentTime()).toBe(t);
  expect(states).toEqual([1, 2]);
  expect(hooks.state).toBe(2);
  expect(hooks.currentTime).toBe(t);
});

test("seekTo: paused stays paused; unstarted starts playing (documented)", async () => {
  const { player, states } = await rig();
  player.seekTo(42, true);
  expect(states).toEqual([1]);
  player.pauseVideo();
  player.seekTo(10, true);
  expect(player.getCurrentTime()).toBe(10);
  expect(states).toEqual([1, 2]);
});

test("seekLatency(ms): emits 3, holds at the target, then restores playing", async () => {
  const { player, states, hooks } = await rig();
  player.playVideo();
  hooks.seekLatency(200);
  player.seekTo(30, true);
  expect(states).toEqual([1, 3]);
  await sleep(100);
  expect(player.getCurrentTime()).toBe(30);
  await sleep(200);
  expect(states).toEqual([1, 3, 1]);
  expect(player.getCurrentTime()).toBeGreaterThan(30);
});

test("buffering(ms): emits 3 then 1, and the clock is frozen meanwhile", async () => {
  const { player, states, hooks } = await rig();
  player.playVideo();
  hooks.buffering(200);
  expect(states).toEqual([1, 3]);
  const t = player.getCurrentTime();
  await sleep(120);
  expect(player.getCurrentTime()).toBe(t);
  expect(hooks.state).toBe(3);
  await sleep(160);
  expect(states).toEqual([1, 3, 1]);
  expect(player.getCurrentTime()).toBeGreaterThan(t);
});

test("ad(ms): emits 3,1 then 3,1; video data and duration follow the ad; content time is kept", async () => {
  const { player, states, hooks } = await rig();
  player.playVideo();
  await sleep(50);
  hooks.ad(250);
  const content = hooks.currentTime;
  expect(states).toEqual([1, 3, 1]);
  expect(player.getVideoData().video_id).not.toBe(VIDEO);
  expect(player.getDuration()).toBe(15);
  await sleep(100);
  expect(player.getCurrentTime()).toBeLessThan(content + 0.001 + 0.2);
  expect(player.getCurrentTime()).toBeGreaterThan(0);
  await sleep(250);
  expect(states).toEqual([1, 3, 1, 3, 1]);
  expect(player.getVideoData().video_id).toBe(VIDEO);
  expect(player.getDuration()).toBeCloseTo(634.5, 3);
  const after = player.getCurrentTime();
  expect(after).toBeGreaterThanOrEqual(content);
  expect(after).toBeLessThan(content + 0.2);
});

test("ad(ms) while paused returns to paused", async () => {
  const { player, states, hooks } = await rig();
  player.playVideo();
  player.pauseVideo();
  hooks.ad(80);
  await sleep(150);
  expect(states).toEqual([1, 2, 3, 1, 3, 2]);
});

test("error(code): emits onError with the code and halts the clock", async () => {
  const { player, errors, hooks } = await rig();
  player.playVideo();
  hooks.error(150);
  expect(errors).toEqual([150]);
  const t = player.getCurrentTime();
  await sleep(80);
  expect(player.getCurrentTime()).toBe(t);
  expect(hooks.events.at(-1)).toMatchObject({ type: "error", data: 150 });
});

test("autoplayBlocked(): unmuted play is blocked with onAutoplayBlocked; muted play works", async () => {
  const r = await rig();
  r.player.playVideo();
  r.hooks.autoplayBlocked();
  expect(r.states).toEqual([1, 2]);
  expect(r.blocked).toBe(1);
  r.player.playVideo();
  expect(r.blocked).toBe(2);
  expect(r.player.getPlayerState()).toBe(2);
  r.player.mute();
  expect(r.player.isMuted()).toBe(true);
  r.player.playVideo();
  expect(r.player.getPlayerState()).toBe(1);
});

test("clickToggle(): a user click toggles play/pause even under the autoplay policy", async () => {
  const { player, states, hooks } = await rig();
  hooks.autoplayBlocked();
  hooks.clickToggle();
  expect(states).toEqual([1]);
  hooks.clickToggle();
  expect(states).toEqual([1, 2]);
  expect(player.getPlayerState()).toBe(2);
});

test("volume is local: mute/unMute/setVolume", async () => {
  const { player } = await rig();
  expect(player.getVolume()).toBe(100);
  player.setVolume(40);
  player.mute();
  expect(player.isMuted()).toBe(true);
  player.unMute();
  expect(player.isMuted()).toBe(false);
  expect(player.getVolume()).toBe(40);
});

test("playing to the end emits 0 (ended) and clamps time to the duration", async () => {
  const { player, states, hooks } = await rig();
  hooks.configure({ duration: 0.15 });
  player.playVideo();
  await sleep(250);
  expect(states).toEqual([1, 0]);
  expect(player.getCurrentTime()).toBe(0.15);
});

test("a non-iframe element is replaced by an embed iframe for options.videoId", () => {
  const host = install();
  const swap: { replaced?: FrameLike } = {};
  const div: FrameLike = { tagName: "DIV", replaceWith: (n) => { swap.replaced = n; } };
  host.document = { getElementById: (id) => (id === "slot" ? div : null), createElement: (tag) => ({ tagName: tag.toUpperCase() }) };
  if (!host.YT) throw new Error("fake did not install YT");
  const p = new host.YT.Player("slot", { videoId: VIDEO });
  expect(p.getIframe()).toBe(swap.replaced ?? div);
  expect(p.getIframe().src).toBe(`https://www.youtube.com/embed/${VIDEO}?enablejsapi=1`);
});
