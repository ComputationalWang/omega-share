import { describe, expect, test } from "bun:test";
import { discoverPairedLive, type LiveProbe } from "./twitch-live";

type Pair = [LiveProbe, LiveProbe];
const playing = (reason = "ungated playing"): LiveProbe => ({
  gate: false, reason, error: null,
  media: { ad: false, paused: false, currentTime: 5, overlay: "" },
});
const ad = (): LiveProbe => ({ ...playing("ungated advertisement"), media: { ad: true, paused: true, currentTime: 0, overlay: "Advertisement" } });
const loading = (reason = "player loading"): LiveProbe => ({ gate: false, reason, error: null, media: null });
const gated = (withAd = false): LiveProbe => ({
  gate: true, reason: "Mature-rated game / Significant Profanity or Vulgarity", error: null,
  media: { ad: withAd, paused: true, currentTime: 0, overlay: "Mature-rated game" },
});

function harness(snapshots: Record<string, Pair[]>) {
  let elapsed = 0;
  const shared: string[] = [];
  const reads = new Map<string, number>();
  return {
    shared, reads, elapsed: () => elapsed,
    deps: {
      share: (channel: string) => { shared.push(channel); return Promise.resolve(); },
      observe: (channel: string): Promise<Pair> => {
        const sequence = snapshots[channel];
        if (!sequence?.length) throw new Error(`Unexpected channel: ${channel}`);
        const index = reads.get(channel) ?? 0;
        reads.set(channel, index + 1);
        const pair = sequence[Math.min(index, sequence.length - 1)];
        if (pair === undefined) throw new Error(`Missing snapshot: ${channel}`);
        return Promise.resolve(pair);
      },
      now: () => elapsed,
      pause: () => { elapsed += 1000; return Promise.resolve(); },
    },
  };
}

describe("paired ungated Twitch live discovery (OME-972)", () => {
  for (const [name, viewerA, viewerB] of [
    ["viewer A advertisement with viewer B mature gate", ad(), gated()],
    ["viewer A playing with viewer B mature gate", playing(), gated()],
    ["viewer B gate and advertisement together", ad(), gated(true)],
    ["viewer A gate and advertisement together", gated(true), playing()],
  ] as const) {
    test(`rejects ${name} and retains both reasons`, async () => {
      const pair: Pair = [viewerA, viewerB];
      const fixture = harness({ gated: [pair] });
      expect(await discoverPairedLive(["gated"], fixture.deps, 2000)).toEqual({ channel: null, tried: [
        { channel: "gated", outcome: "no-start", viewers: pair },
      ] });
    });
  }

  test("rejects viewer B offline even while viewer A plays", async () => {
    const pair: Pair = [playing(), { ...loading("viewer B: stream offline"), error: { reason: "offline" }, media: { ad: false, paused: true, currentTime: 0, overlay: "Channel offline" } }];
    const fixture = harness({ offline: [pair] });
    expect(await discoverPairedLive(["offline"], fixture.deps, 2000)).toEqual({ channel: null, tried: [
      { channel: "offline", outcome: "offline", viewers: pair },
    ] });
  });

  test("rejects viewer B player error even while viewer A shows an ad", async () => {
    const pair: Pair = [ad(), { ...loading("viewer B: content unavailable"), error: { reason: "unavailable" } }];
    const fixture = harness({ error: [pair] });
    expect(await discoverPairedLive(["error"], fixture.deps, 2000)).toEqual({ channel: null, tried: [
      { channel: "error", outcome: "error", viewers: pair },
    ] });
  });

  test("waits for both ungated viewers in the same snapshot", async () => {
    const ready: Pair = [playing("viewer A ready"), playing("viewer B ready")];
    const fixture = harness({ delayed: [[playing(), loading("viewer B loading")], ready] });
    expect(await discoverPairedLive(["delayed"], fixture.deps, 3000)).toEqual({ channel: "delayed", tried: [
      { channel: "delayed", outcome: "live", viewers: ready },
    ] });
    expect(fixture.reads.get("delayed")).toBe(2);
  });

  test("does not combine alternating readiness across snapshots", async () => {
    const final: Pair = [loading("viewer A stalled"), playing("viewer B ready")];
    const fixture = harness({ alternating: [[playing("viewer A ready"), loading("viewer B loading")], final] });
    expect(await discoverPairedLive(["alternating"], fixture.deps, 2000)).toEqual({ channel: null, tried: [
      { channel: "alternating", outcome: "no-start", viewers: final },
    ] });
    expect(fixture.elapsed()).toBe(2000);
  });

  for (const [name, ready] of [["advertisements", [ad(), ad()]], ["playing media", [playing(), playing()]]] as const) {
    test(`accepts two ungated viewers with ${name}`, async () => {
      const pair: Pair = [ready[0], ready[1]];
      const fixture = harness({ ready: [pair] });
      expect(await discoverPairedLive(["ready"], fixture.deps, 2000)).toEqual({ channel: "ready", tried: [
        { channel: "ready", outcome: "live", viewers: pair },
      ] });
      expect(fixture.elapsed()).toBe(0);
    });
  }

  test("returns an explicit empty result with no candidates", async () => {
    const fixture = harness({});
    expect(await discoverPairedLive([], fixture.deps)).toEqual({ channel: null, tried: [] });
    expect(fixture.shared).toEqual([]);
  });

  test("bounds each candidate and continues to the next ready pair", async () => {
    const waiting: Pair = [loading("viewer A absent frame"), loading("viewer B loading")];
    const ready: Pair = [playing(), ad()];
    const fixture = harness({ waiting: [waiting], ready: [ready] });
    expect(await discoverPairedLive(["waiting", "ready"], fixture.deps, 2000, 10_000)).toEqual({ channel: "ready", tried: [
      { channel: "waiting", outcome: "no-start", viewers: waiting },
      { channel: "ready", outcome: "live", viewers: ready },
    ] });
    expect(fixture.elapsed()).toBe(2000);
    expect(fixture.shared).toEqual(["waiting", "ready"]);
  });

  test("stops at the global budget without sharing another candidate", async () => {
    const waiting: Pair = [loading("viewer A loading"), loading("viewer B loading")];
    const fixture = harness({ first: [waiting], second: [waiting], forbidden: [[playing(), playing()]] });
    const result = await discoverPairedLive(["first", "second", "forbidden"], fixture.deps, 2000, 3000);
    expect(result.channel).toBeNull();
    expect(fixture.elapsed()).toBe(3000);
    expect(fixture.shared).toEqual(["first", "second"]);
    expect(result.tried.map(({ outcome }) => outcome)).toEqual(["no-start", "no-start"]);
  });
});
