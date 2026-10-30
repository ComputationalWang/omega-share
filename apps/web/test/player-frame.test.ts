import { describe, expect, test } from "bun:test";
import type { FrameMessage, FrameToExtension } from "../src/extension-bridge";
import type { PlayerAdapter, PlayerEvent } from "../src/player/adapter";
import { ATTACH_TIMEOUT_MS, mountFrame } from "../src/player/frame";

// ADR 0057 §4: the generic tier's adapter. It drives the attached frame's <video> through the extension bridge and
// mirrors the last frame-state; time() extrapolates from it like the sync loop's own model.

const HOST = "media.example.org";
const state = (over: Record<string, unknown> = {}) =>
  ({ source: "omega-share", kind: "frame-state", host: HOST, state: "paused", position: 10, rate: 1, duration: 600, live: false, muted: false, ...over }) as FrameMessage;

function harness() {
  const t = { now: 0 };
  const sent: FrameToExtension[] = [];
  let listener: ((m: FrameMessage) => void) | null = null;
  const timers: { fn: () => void; at: number; cleared: boolean }[] = [];
  const sync: boolean[] = [];
  const result = mountFrame({
    host: HOST,
    bridge: {
      toFrame: (m) => sent.push(m),
      onFrame: (cb) => {
        listener = cb;
        return () => {
          if (listener === cb) listener = null;
        };
      },
    },
    now: () => t.now,
    setTimeout: (fn, ms) => {
      const h = { fn, at: t.now + ms, cleared: false };
      timers.push(h);
      return h;
    },
    clearTimeout: (h) => {
      h.cleared = true;
    },
    onSync: (on) => sync.push(on),
  });
  const deliver = (m: FrameMessage) => listener?.(m);
  const advance = (ms: number) => {
    t.now += ms;
    for (const h of timers) if (!h.cleared && h.at <= t.now) {
      h.cleared = true;
      h.fn();
    }
  };
  return { t, sent, deliver, advance, result, sync, listening: () => listener !== null };
}

async function attached() {
  const h = harness();
  h.deliver(state());
  const r = await h.result;
  if (!r.ok) throw new Error(`mount failed: ${r.reason}`);
  const events: PlayerEvent[] = [];
  r.player.onEvent((e) => events.push(e));
  h.sent.length = 0;
  return { ...h, player: r.player, events };
}

describe("frame adapter mount (ADR 0057 §4)", () => {
  test("asks the extension to attach to the host's frame", () => {
    const h = harness();
    expect(h.sent).toEqual([{ source: "omega-share", kind: "attach", host: HOST }]);
  });

  test("the first frame-state for the host resolves a ready player; one for another host doesn't", async () => {
    const h = harness();
    let done = false;
    void h.result.then(() => (done = true));
    h.deliver(state({ host: "other.example.org" }));
    await Promise.resolve();
    expect(done).toBe(false);
    h.deliver(state({ state: "playing", position: 42 }));
    const r = await h.result;
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.player.ready()).toBe(true);
    expect(r.player.state()).toBe("playing");
    expect(r.player.duration()).toBe(600);
    expect(r.player.caps).toEqual({ seek: true, live: false, rate: "yes" });
    expect(h.sync).toEqual([true]);
  });

  test("no frame-state within the attach timeout: timeout, and the listener is dropped", async () => {
    const h = harness();
    h.advance(ATTACH_TIMEOUT_MS);
    expect(await h.result).toEqual({ ok: false, reason: "timeout" });
    expect(h.listening()).toBe(false);
    expect(ATTACH_TIMEOUT_MS).toBe(5000);
  });
});

describe("frame adapter as a player", () => {
  test("time() extrapolates position + rate × elapsed while playing, and holds while paused", async () => {
    const h = await attached();
    h.deliver(state({ state: "playing", position: 100, rate: 1.25 }));
    h.t.now += 2000;
    expect(h.player.time()).toBe(102.5);
    h.deliver(state({ state: "paused", position: 103 }));
    h.t.now += 5000;
    expect(h.player.time()).toBe(103);
  });

  test("time() never runs past a known duration", async () => {
    const h = await attached();
    h.deliver(state({ state: "playing", position: 599, duration: 600 }));
    h.t.now += 10_000;
    expect(h.player.time()).toBe(600);
  });

  test("commands go to the frame as frame-command for the host", async () => {
    const h = await attached();
    h.player.play();
    h.player.pause();
    h.player.seek(12.5);
    h.player.setRate(1.5);
    h.player.setVolume(40);
    h.player.unmute();
    const base = { source: "omega-share", kind: "frame-command", host: HOST } as const;
    expect(h.sent).toEqual([
      { ...base, op: "play" },
      { ...base, op: "pause" },
      { ...base, op: "seek", value: 12.5 },
      { ...base, op: "rate", value: 1.5 },
      { ...base, op: "volume", value: 40 },
      { ...base, op: "unmute" },
    ]);
  });

  test("a state change is an event; the same state again isn't", async () => {
    const h = await attached();
    h.deliver(state({ state: "playing" }));
    h.deliver(state({ state: "playing", position: 11 }));
    h.deliver(state({ state: "ended" }));
    expect(h.events).toEqual([
      { type: "state", state: "playing" },
      { type: "state", state: "ended" },
    ]);
  });

  test("frame-intent becomes the player's intent", async () => {
    const h = await attached();
    h.deliver({ source: "omega-share", kind: "frame-intent", host: HOST, playing: true, position: 33 });
    expect(h.events).toEqual([{ type: "intent", playing: true, position: 33 }]);
  });

  test("a live stream (duration Infinity) is play/pause only, with no duration", async () => {
    const h = harness();
    h.deliver(state({ live: true, duration: null }));
    const r = await h.result;
    if (!r.ok) throw new Error("mount failed");
    expect(r.player.caps).toEqual({ seek: false, live: true, rate: "no" });
    expect(r.player.duration()).toBe(0);
  });

  test("frame-lost: not ready, commands dropped, unsynced; a new frame-state brings it back", async () => {
    const h = await attached();
    h.deliver({ source: "omega-share", kind: "frame-lost", host: HOST });
    expect(h.player.ready()).toBe(false);
    expect(h.sync).toEqual([true, false]);
    h.player.play();
    expect(h.sent).toEqual([]);
    h.deliver(state({ state: "paused" }));
    expect(h.player.ready()).toBe(true);
    expect(h.sync).toEqual([true, false, true]);
    expect(h.events).toContainEqual({ type: "ready" });
  });

  test("destroy stops listening and sends nothing more", async () => {
    const h = await attached();
    const p: PlayerAdapter = h.player;
    p.destroy();
    p.destroy();
    p.play();
    expect(h.listening()).toBe(false);
    expect(h.sent).toEqual([]);
  });
});
