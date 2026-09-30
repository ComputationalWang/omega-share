import { describe, expect, test } from "bun:test";
import { OBSERVER_MARK, frameWorkMs } from "./frame-work";

// Synthetic Chromium trace (ADR 0017): the observer's main thread is pid 7 / tid 1, marked with OBSERVER_MARK.
const OBS = { pid: 7, tid: 1 };
const mark = { name: OBSERVER_MARK, cat: "blink.user_timing", ph: "R", ts: 500, ...OBS };
const frame = (ts: number, at = OBS) => ({ name: "BeginMainThreadFrame", cat: "disabled-by-default-devtools.timeline.frame", ph: "I", ts, ...at });
const task = (ts: number, dur: number, at = OBS) => ({ name: "ThreadControllerImpl::RunTask", cat: "toplevel", ph: "X", ts, dur, ...at });

describe("frameWorkMs", () => {
  test("sums the observer thread's RunTask time between consecutive BeginMainThreadFrames, in ms", () => {
    const events = [mark, frame(1000), task(1100, 300), task(1500, 200), frame(17_667), task(17_700, 1000), frame(34_333)];
    expect(frameWorkMs({ traceEvents: events })).toEqual([0.5, 1]);
  });

  test("ignores other processes and threads, and work outside the frame window", () => {
    const other = { pid: 9, tid: 1 };
    const sibling = { pid: 7, tid: 2 };
    const events = [
      task(900, 5000),
      mark,
      frame(1000),
      frame(1200, other),
      task(1100, 400),
      task(1100, 9000, other),
      task(1100, 9000, sibling),
      frame(17_667),
      task(20_000, 3000),
    ];
    expect(frameWorkMs({ traceEvents: events })).toEqual([0.4]);
  });

  test("a frame with no task counts as 0 ms, and events need not arrive in order", () => {
    const events = [frame(17_667), task(1100, 250), mark, frame(34_333), frame(1000)];
    expect(frameWorkMs({ traceEvents: events })).toEqual([0.25, 0]);
  });

  test("accepts Chromium's bare event array too", () => {
    expect(frameWorkMs([mark, frame(0), task(10, 100), frame(16_667)])).toEqual([0.1]);
  });

  test("throws when the observer mark is missing, so a mis-wired spec can't report 0 ms", () => {
    expect(() => frameWorkMs({ traceEvents: [frame(0), frame(16_667)] })).toThrow(OBSERVER_MARK);
  });

  test("throws when the observer thread has fewer than two frames", () => {
    expect(() => frameWorkMs({ traceEvents: [mark, frame(0)] })).toThrow("BeginMainThreadFrame");
  });

  test("rejects a malformed trace at the boundary", () => {
    expect(() => frameWorkMs({ traceEvents: [{ name: "x", ph: "X", pid: "7", tid: 1, ts: 0 }] })).toThrow();
    expect(() => frameWorkMs("not a trace")).toThrow();
  });

  test("skips metadata events that carry no ts", () => {
    const meta = { name: "thread_name", ph: "M", pid: 7, tid: 1, args: { name: "CrRendererMain" } };
    expect(frameWorkMs({ traceEvents: [meta, mark, frame(0), task(5, 50), frame(16_667)] })).toEqual([0.05]);
  });
});
