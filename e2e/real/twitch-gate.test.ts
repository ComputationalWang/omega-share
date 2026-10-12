import { describe, expect, test } from "bun:test";
import { collectGateEvidence, discoverPairedGate, runGateWorkflow, type GateProbe } from "./twitch-gate";

const gate = (reason = "mature overlay visible"): GateProbe => ({ gate: true, reason });
const absent = (reason: string): GateProbe => ({ gate: false, reason });
type Pair = [GateProbe, GateProbe];

function discoveryHarness(snapshots: Record<string, Pair[]>) {
  let elapsed = 0;
  const shared: string[] = [];
  const reads = new Map<string, number>();
  return {
    shared,
    deps: {
      share: (channel: string) => {
        shared.push(channel);
        return Promise.resolve();
      },
      observe: (channel: string): Promise<Pair> => {
        const sequence = snapshots[channel];
        if (!sequence?.length) throw new Error(`Unexpected channel: ${channel}`);
        const index = reads.get(channel) ?? 0;
        reads.set(channel, index + 1);
        const snapshot = sequence[Math.min(index, sequence.length - 1)];
        if (snapshot === undefined) throw new Error(`Missing snapshot: ${channel}`);
        return Promise.resolve(snapshot);
      },
      now: () => elapsed,
      pause: () => {
        elapsed += 1000;
        return Promise.resolve();
      },
    },
  };
}

describe("paired Twitch mature-gate discovery (OME-950)", () => {
  test("rejects an asymmetric candidate and selects the next simultaneously gated pair", async () => {
    const unavailable: Pair = [gate(), absent("viewer 2: stream unavailable")];
    const ready: Pair = [gate("viewer 1 gate"), gate("viewer 2 gate")];
    const harness = discoveryHarness({ first: [unavailable], second: [ready] });

    const result = await discoverPairedGate(["first", "second"], harness.deps, 2000);

    expect(harness.shared).toEqual(["first", "second"]);
    expect(result).toEqual({ channel: "second", tried: [
      { channel: "first", outcome: "unavailable", viewers: unavailable },
      { channel: "second", outcome: "gated", viewers: ready },
    ] });
  });

  test("never combines viewer successes from different snapshots", async () => {
    const final: Pair = [absent("viewer 1: overlay disappeared"), gate()];
    const harness = discoveryHarness({ alternating: [
      [gate(), absent("viewer 2: loading")], final,
    ] });

    const result = await discoverPairedGate(["alternating"], harness.deps, 2000);

    expect(result.channel).toBeNull();
    expect(result.tried).toEqual([
      { channel: "alternating", outcome: "unavailable", viewers: final },
    ]);
  });

  test("keeps polling the candidate until both gates appear together", async () => {
    const ready: Pair = [gate(), gate()];
    const harness = discoveryHarness({ delayed: [
      [absent("viewer 1: loading"), absent("viewer 2: loading")], ready,
    ] });

    const result = await discoverPairedGate(["delayed"], harness.deps, 2000);

    expect(harness.shared).toEqual(["delayed"]);
    expect(result).toEqual({ channel: "delayed", tried: [
      { channel: "delayed", outcome: "gated", viewers: ready },
    ] });
  });

  test("returns an explicit unavailable result when discovery has no candidates", async () => {
    const harness = discoveryHarness({});

    expect(await discoverPairedGate([], harness.deps, 2000)).toEqual({ channel: null, tried: [] });
    expect(harness.shared).toEqual([]);
  });

  test("records the final per-viewer timeout and absent-frame reasons", async () => {
    const final: Pair = [absent("viewer 1: gate timeout; player offline"), absent("viewer 2: Twitch frame absent")];
    const harness = discoveryHarness({ offline: [
      [absent("viewer 1: loading"), absent("viewer 2: loading")], final,
    ] });

    expect(await discoverPairedGate(["offline"], harness.deps, 2000)).toEqual({ channel: null, tried: [
      { channel: "offline", outcome: "unavailable", viewers: final },
    ] });
  });

  test("caps discovery at eight candidates even when a ninth would be available", async () => {
    const candidates = Array.from({ length: 9 }, (_, index) => `candidate-${String(index)}`);
    const snapshots: Record<string, Pair[]> = Object.fromEntries(candidates.map((channel, index) => [
      channel, [index === 8 ? [gate(), gate()] : [absent("offline"), absent("offline")]],
    ]));
    const harness = discoveryHarness(snapshots);

    const result = await discoverPairedGate(candidates, harness.deps, 2000);

    expect(result.channel).toBeNull();
    expect(harness.shared).toEqual(candidates.slice(0, 8));
    expect(result.tried.map(({ channel }) => channel)).toEqual(candidates.slice(0, 8));
    expect(result.tried.every(({ outcome }) => outcome === "unavailable")).toBe(true);
  });
});

describe("paired gate failure evidence (OME-950)", () => {
  test("expired workflow cannot start another room action when its pending observation finishes", async () => {
    let finishObservation: () => void = () => undefined;
    const observation = new Promise<void>((resolve) => { finishObservation = resolve; });
    const actions: string[] = [];
    let finished: Promise<void> = Promise.resolve();
    const result = runGateWorkflow((checkActive) => {
      finished = (async () => {
        await observation;
        checkActive();
        actions.push("shared-pause");
      })();
      return finished;
    }, 10);
    expect(await result.catch((error: unknown) => error)).toEqual(new Error("M3 workflow exceeded its deadline; reserving paired failure capture time"));
    finishObservation();
    expect(await finished.catch((error: unknown) => error)).toEqual(new Error("M3 workflow exceeded its deadline; reserving paired failure capture time"));
    expect(actions).toEqual([]);
  });

  test("returns the other viewer's evidence and an explicit error when one capture never settles", async () => {
    const result = await collectGateEvidence({
      "viewer-1-snapshot": () => new Promise(() => {
        // This viewer's capture never settles.
      }),
      "viewer-2-screenshot": () => Promise.resolve("viewer-2.png"),
      "viewer-2-trace": () => Promise.resolve("viewer-2-trace.zip"),
    }, 20);

    expect(result["viewer-1-snapshot"]?.error).toContain("capture timed out after 20 ms");
    expect(result["viewer-2-screenshot"]).toEqual({ value: "viewer-2.png" });
    expect(result["viewer-2-trace"]).toEqual({ value: "viewer-2-trace.zip" });
  }, 100);

  test("attempts every task and retains screenshots and paired snapshots when another capture fails", async () => {
    const attempted: string[] = [];
    const paired = { viewers: [{ gate: true, media: { paused: false } }, { gate: false, reason: "frame absent" }] };
    const result = await collectGateEvidence({
      broken: () => {
        attempted.push("broken");
        throw new Error("frame detached during capture");
      },
      paired: () => {
        attempted.push("paired");
        return Promise.resolve(paired);
      },
      screenshot: () => {
        attempted.push("screenshot");
        return Promise.resolve("viewer-2.png");
      },
      network: () => {
        attempted.push("network");
        return Promise.reject(new Error("network capture unavailable"));
      },
    });

    expect(attempted.sort()).toEqual(["broken", "network", "paired", "screenshot"]);
    expect(result["paired"]).toEqual({ value: paired });
    expect(result["screenshot"]).toEqual({ value: "viewer-2.png" });
    expect(result["broken"]?.error).toContain("frame detached during capture");
    expect(result["network"]?.error).toContain("network capture unavailable");
    expect(typeof result["broken"]?.error).toBe("string");
  });
});
