// Main-thread work per frame from a Chromium trace (ADR 0017, docs/research/m3-frame-headroom.md).
import * as v from "valibot";

/** `performance.mark` name that tags the observer page's main thread in the trace. */
export const OBSERVER_MARK = "omega:observer";

/** Minimal categories: RunTask (toplevel), BeginMainThreadFrame (timeline.frame) and the observer mark (user_timing). */
export const TRACE_CATEGORIES = ["toplevel", "disabled-by-default-devtools.timeline.frame", "blink.user_timing"];

const TraceEvent = v.object({
  name: v.string(),
  ph: v.string(),
  pid: v.number(),
  tid: v.number(),
  ts: v.optional(v.number()),
  dur: v.optional(v.number()),
});
const Trace = v.union([v.object({ traceEvents: v.array(TraceEvent) }), v.array(TraceEvent)]);

/**
 * Per-frame main-thread work (ms) on the observer's thread: the summed `dur` of `ThreadControllerImpl::RunTask`
 * starting in each `[BeginMainThreadFrame_i, BeginMainThreadFrame_i+1)`.
 */
export function frameWorkMs(trace: unknown, mark = OBSERVER_MARK): number[] {
  const parsed = v.parse(Trace, trace);
  const events = Array.isArray(parsed) ? parsed : parsed.traceEvents;
  const observer = events.find((e) => e.name === mark);
  if (observer === undefined) throw new Error(`trace has no ${mark} mark: is the observer marked while tracing?`);
  const onThread = events.filter((e) => e.pid === observer.pid && e.tid === observer.tid);
  const at = (name: string) =>
    onThread
      .filter((e) => e.name === name)
      .flatMap((e) => (e.ts === undefined ? [] : [{ ts: e.ts, dur: e.dur ?? 0 }]))
      .sort((a, b) => a.ts - b.ts);
  const frames = at("BeginMainThreadFrame").map((e) => e.ts);
  if (frames.length < 2) throw new Error(`observer thread has ${String(frames.length)} BeginMainThreadFrame events, need 2+`);
  const tasks = at("ThreadControllerImpl::RunTask");
  return frames.slice(0, -1).map((start, i) => {
    const end = frames[i + 1] ?? start;
    const us = tasks.filter((t) => t.ts >= start && t.ts < end).reduce((sum, t) => sum + t.dur, 0);
    return us / 1000;
  });
}
