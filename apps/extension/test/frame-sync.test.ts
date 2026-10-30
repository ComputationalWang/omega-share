import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import * as v from "valibot";
import { MAX_POSITION_S } from "@omega/shared";
import { FrameIntentMessageSchema, FrameLostMessageSchema, FrameStateMessageSchema } from "@omega/shared/extension-bridge";
import { type FrameEnv, frameSync } from "../src/frame-sync";

// ADR 0057 §3 and §5 (OME-1974): the script injected into the unlocked host's frame in the room tab.
const HOST = "kwik.cx";

function frame(opts: { top?: boolean; hostname?: string } = {}) {
  const win = new Window({ url: `https://${opts.hostname ?? HOST}/e/ockxKpNdX2Kh` });
  if (opts.top !== true) Object.defineProperty(win, "top", { value: {} });
  let active = false;
  Object.defineProperty(win.navigator, "userActivation", { value: { get isActive() { return active; } } });
  const sent: unknown[] = [];
  const listeners = new Set<(m: unknown) => void>();
  const env: FrameEnv = {
    win: win as unknown as FrameEnv["win"],
    runtime: {
      sendMessage: (m) => (sent.push(m), Promise.resolve()),
      onMessage: { addListener: (l) => void listeners.add(l), removeListener: (l) => void listeners.delete(l) },
    },
  };
  function addVideo(): HTMLVideoElement {
    const video = win.document.createElement("video") as unknown as HTMLVideoElement;
    // happy-dom never loads media: say it has data, so a playing video reads as "playing".
    Object.defineProperty(video, "readyState", { value: 4, configurable: true });
    Object.defineProperty(video, "duration", { value: 1370, configurable: true });
    win.document.body.append(video as unknown as Node & Parameters<typeof win.document.body.append>[0]);
    return video;
  }
  const fire = (video: HTMLVideoElement, type: string): boolean => video.dispatchEvent(new win.Event(type) as unknown as Event);
  const command = (m: unknown): void => {
    for (const l of listeners) l(m);
  };
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  return { win, env, sent, listeners, addVideo, fire, command, tick, activate: (on = true) => (active = on) };
}

const kinds = (sent: unknown[]) => sent.map((m) => (m as { kind: string }).kind);
const last = (sent: unknown[]) => sent.at(-1) as Record<string, unknown>;
const cmd = (op: string, value?: number) => ({ source: "omega-share", kind: "frame-command", host: HOST, op, ...(value === undefined ? {} : { value }) });

describe("frameSync", () => {
  test("stays out of the top frame and of any other host's frame", async () => {
    for (const f of [frame({ top: true }), frame({ hostname: "other-host.net" })]) {
      f.addVideo();
      frameSync(HOST, f.env);
      await f.tick();
      expect(f.listeners.size).toBe(0);
      expect(f.sent).toEqual([]);
    }
  });

  test("reports a valid frame-state for a video already in the frame", () => {
    const f = frame();
    const video = f.addVideo();
    frameSync(HOST, f.env);
    f.fire(video, "loadedmetadata");
    const state = v.parse(FrameStateMessageSchema, last(f.sent));
    expect(state).toEqual({ source: "omega-share", kind: "frame-state", host: HOST, state: "paused", position: 0, rate: 1, duration: 1370, live: false, muted: false });
  });

  test("reports a video that is already loaded and paused on attach, with no event (OME-2029)", () => {
    const f = frame();
    f.addVideo();
    frameSync(HOST, f.env);
    expect(v.parse(FrameStateMessageSchema, last(f.sent)).state).toBe("paused");
  });

  test("finds a video that appears later", async () => {
    const f = frame();
    frameSync(HOST, f.env);
    const video = f.addVideo();
    await f.tick();
    f.fire(video, "pause");
    expect(kinds(f.sent)).toContain("frame-state");
  });

  test("states: playing, buffering, ended; live streams have no duration", async () => {
    const f = frame();
    const video = f.addVideo();
    frameSync(HOST, f.env);
    await video.play();
    expect(last(f.sent)["state"]).toBe("playing");
    Object.defineProperty(video, "readyState", { value: 2, configurable: true });
    f.fire(video, "waiting");
    expect(last(f.sent)["state"]).toBe("buffering");
    Object.defineProperty(video, "ended", { value: true, configurable: true });
    f.fire(video, "ended");
    expect(last(f.sent)["state"]).toBe("ended");
    Object.defineProperty(video, "duration", { value: Infinity, configurable: true });
    f.fire(video, "durationchange");
    expect(v.parse(FrameStateMessageSchema, last(f.sent))).toMatchObject({ duration: null, live: true });
  });

  test("clamps a position and rate the room can't carry", () => {
    const f = frame();
    const video = f.addVideo();
    frameSync(HOST, f.env);
    Object.defineProperty(video, "currentTime", { value: MAX_POSITION_S + 10, configurable: true });
    video.playbackRate = 4;
    f.fire(video, "ratechange");
    expect(v.parse(FrameStateMessageSchema, last(f.sent))).toMatchObject({ position: MAX_POSITION_S, rate: 2 });
  });

  test("reports once a second while playing, not while paused", async () => {
    const f = frame();
    const video = f.addVideo();
    frameSync(HOST, f.env);
    await new Promise((r) => setTimeout(r, 1100));
    expect(kinds(f.sent)).toEqual(["frame-state"]); // the attach report only
    await video.play();
    const before = f.sent.length;
    await new Promise((r) => setTimeout(r, 1100));
    expect(f.sent.length).toBe(before + 1);
    f.command({ source: "omega-share", kind: "frame-detach" });
  });

  test("drives the video: play, pause, seek, rate, volume, unmute", async () => {
    const f = frame();
    const video = f.addVideo();
    video.muted = true;
    frameSync(HOST, f.env);
    f.command(cmd("play"));
    await f.tick();
    expect(video.paused).toBe(false);
    f.command(cmd("seek", 300));
    expect(video.currentTime).toBe(300);
    f.command(cmd("rate", 1.5));
    expect(video.playbackRate).toBe(1.5);
    f.command(cmd("volume", 40));
    expect(video.volume).toBeCloseTo(0.4);
    f.command(cmd("unmute"));
    expect(video.muted).toBe(false);
    f.command(cmd("pause"));
    expect(video.paused).toBe(true);
  });

  test("ignores commands for another host or of an unknown shape", () => {
    const f = frame();
    const video = f.addVideo();
    frameSync(HOST, f.env);
    f.command({ ...cmd("seek", 300), host: "other-host.net" });
    f.command({ ...cmd("seek"), value: "300" });
    f.command("seek");
    expect(video.currentTime).toBe(0);
  });

  test("a user's play, pause or seek inside the frame becomes a frame-intent", async () => {
    const f = frame();
    const video = f.addVideo();
    frameSync(HOST, f.env);
    f.activate();
    await video.play();
    expect(v.parse(FrameIntentMessageSchema, f.sent.find((m) => (m as { kind: string }).kind === "frame-intent"))).toEqual({
      source: "omega-share",
      kind: "frame-intent",
      host: HOST,
      playing: true,
      position: 0,
    });
    video.currentTime = 42;
    f.fire(video, "seeked");
    expect(f.sent.filter((m) => (m as { kind: string }).kind === "frame-intent").at(-1)).toMatchObject({ playing: true, position: 42 });
    video.pause();
    expect(f.sent.filter((m) => (m as { kind: string }).kind === "frame-intent").at(-1)).toMatchObject({ playing: false });
  });

  test("no frame-intent without user activation: the host page's script can't drive the room", async () => {
    const f = frame();
    const video = f.addVideo();
    frameSync(HOST, f.env);
    await video.play();
    f.fire(video, "seeked");
    video.pause();
    expect(kinds(f.sent)).not.toContain("frame-intent");
  });

  test("our own commands' echoes are not intents, even right after a click", async () => {
    const f = frame();
    const video = f.addVideo();
    frameSync(HOST, f.env);
    f.activate();
    f.command(cmd("play"));
    await f.tick();
    f.command(cmd("seek", 30));
    f.fire(video, "seeked");
    f.command(cmd("pause"));
    expect(kinds(f.sent)).not.toContain("frame-intent");
    // The echo is spent: the user's next seek counts.
    f.fire(video, "seeked");
    expect(kinds(f.sent)).toContain("frame-intent");
  });

  test("frame-lost when the video goes away or the frame unloads", async () => {
    const f = frame();
    const video = f.addVideo();
    frameSync(HOST, f.env);
    (video as unknown as { remove(): void }).remove();
    await f.tick();
    expect(v.parse(FrameLostMessageSchema, last(f.sent))).toEqual({ source: "omega-share", kind: "frame-lost", host: HOST });
    const g = frame();
    g.addVideo();
    frameSync(HOST, g.env);
    g.win.dispatchEvent(new g.win.Event("pagehide"));
    expect(last(g.sent)["kind"]).toBe("frame-lost");
  });

  test("frame-detach removes every listener; a second injection replaces the first", async () => {
    const f = frame();
    const video = f.addVideo();
    frameSync(HOST, f.env);
    frameSync(HOST, f.env);
    expect(f.listeners.size).toBe(1);
    f.command({ source: "omega-share", kind: "frame-detach" });
    expect(f.listeners.size).toBe(0);
    f.sent.length = 0;
    f.fire(video, "pause");
    f.addVideo();
    await f.tick();
    expect(f.sent).toEqual([]);
  });

  test("is self-contained, as scripting.executeScript serializes it", () => {
    const f = frame();
    const video = f.addVideo();
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- the point: run it from its source, as the browser does
    const injected = (new Function(`return ${frameSync.toString()}`) as () => typeof frameSync)();
    injected(HOST, f.env);
    f.fire(video, "pause");
    expect(kinds(f.sent)).toEqual(["frame-state", "frame-state"]);
  });
});
