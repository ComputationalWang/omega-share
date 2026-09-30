import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Ticker } from "pixi.js";
import { quietSystemTicker } from "../src/room-view";

// OME-185: the room renders on demand, but Pixi's SchedulerSystem (texture GC timers) and EventsTicker sit on
// Ticker.system, which auto-starts a requestAnimationFrame loop that ran every frame for nothing (trace: ~0.06 ms/frame).
let requested = 0;
const realRaf = globalThis.requestAnimationFrame;
const realCaf = globalThis.cancelAnimationFrame;
beforeEach(() => {
  requested = 0;
  globalThis.requestAnimationFrame = () => ++requested;
  globalThis.cancelAnimationFrame = () => undefined;
});
afterEach(() => {
  globalThis.requestAnimationFrame = realRaf;
  globalThis.cancelAnimationFrame = realCaf;
});

function systemLikeTicker(): Ticker {
  const t = new Ticker();
  t.autoStart = true;
  return t;
}

describe("quietSystemTicker", () => {
  test("an auto-start ticker requests frames as soon as it has a listener (the bug)", () => {
    systemLikeTicker().add(() => undefined);
    expect(requested).toBeGreaterThan(0);
  });

  test("a quieted ticker requests no frames, even when Pixi adds a listener later", () => {
    const t = systemLikeTicker();
    t.add(() => undefined);
    quietSystemTicker(t);
    requested = 0;
    t.add(() => undefined);
    t.addOnce(() => undefined);
    expect(requested).toBe(0);
    expect(t.started).toBe(false);
  });

  test("the pump runs the ticker's listeners once per call, so Pixi's GC timers still advance on our renders", () => {
    const t = systemLikeTicker();
    let runs = 0;
    t.add(() => {
      runs++;
    });
    const pump = quietSystemTicker(t);
    requested = 0;
    pump();
    pump();
    expect(runs).toBe(2);
    expect(requested).toBe(0);
  });
});
