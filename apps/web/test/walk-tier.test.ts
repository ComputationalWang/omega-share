import { describe, expect, test } from "bun:test";
import { createTier, createTierProbe, parseForcedTier, readTierHints, type TierHints } from "../src/walk/tier";

// OME-731 (ADR 0037, research R-M8a §3): which walk tier a device gets. Static gates first; otherwise start in Basic, probe
// the post-render work of the first 30 renders, upgrade to Smooth if it fits, and drop back to Basic for the session if
// Smooth walking frames get slow or late. Never back up until reload.

const capable: TierHints = { forced: null, reducedMotion: false, saveData: false, hardwareConcurrency: 8, deviceMemory: 8 };

/** Feeds `n` Basic renders that each took `ms` of work, with a rAF interval of `every` ms next to each. */
function probe(tier: ReturnType<typeof createTier>, n: number, ms: number | ((i: number) => number), every = 1000 / 60): void {
  for (let i = 0; i < n; i++) {
    tier.interval(every);
    tier.work(typeof ms === "number" ? ms : ms(i), false);
  }
}

/** Upgraded to Smooth on a fast device. */
function smoothTier(): ReturnType<typeof createTier> {
  const tier = createTier(capable);
  probe(tier, 30, 2);
  expect(tier.smooth()).toBe(true);
  return tier;
}

describe("static gates", () => {
  test("a capable device starts in Basic, probing", () => {
    const tier = createTier(capable);
    expect(tier.smooth()).toBe(false);
    expect(tier.probing()).toBe(true);
  });

  test("Save-Data, fewer than 4 threads or a reported device memory under 4 GB: Basic for the session, no probe", () => {
    for (const h of [{ saveData: true }, { hardwareConcurrency: 2 }, { deviceMemory: 2 }, { reducedMotion: true }]) {
      const tier = createTier({ ...capable, ...h });
      expect(tier.probing()).toBe(false);
      probe(tier, 60, 1);
      expect(tier.smooth()).toBe(false);
    }
  });

  test("device memory and thread count that aren't reported don't hold a device back", () => {
    const tier = createTier({ ...capable, hardwareConcurrency: undefined, deviceMemory: undefined });
    probe(tier, 30, 2);
    expect(tier.smooth()).toBe(true);
  });

  test("a forced tier wins and never changes, whatever the device or the probe says", () => {
    const smooth = createTier({ ...capable, forced: "smooth", hardwareConcurrency: 2, saveData: true });
    expect(smooth.smooth()).toBe(true);
    expect(smooth.probing()).toBe(false);
    for (let i = 0; i < 300; i++) smooth.work(30, true);
    for (let i = 0; i < 600; i++) smooth.interval(i % 2 ? 50 : 16.7);
    expect(smooth.smooth()).toBe(true);
    const basic = createTier({ ...capable, forced: "basic" });
    probe(basic, 30, 1);
    expect(basic.smooth()).toBe(false);
  });
});

describe("upgrade over the first 30 renders", () => {
  test("p95 work ≤ 8 ms and a median rAF interval ≤ 20 ms: Smooth from the 30th render on, not before", () => {
    const tier = createTier(capable);
    probe(tier, 29, 3);
    expect(tier.smooth()).toBe(false);
    probe(tier, 1, 3);
    expect(tier.smooth()).toBe(true);
    expect(tier.probing()).toBe(false);
  });

  test("one slow render in 30 is the 5 % tail and still upgrades; two keep Basic for the session", () => {
    const one = createTier(capable);
    probe(one, 30, (i) => (i === 7 ? 40 : 3));
    expect(one.smooth()).toBe(true);
    const two = createTier(capable);
    probe(two, 30, (i) => (i === 7 || i === 20 ? 9 : 3));
    expect(two.smooth()).toBe(false);
    expect(two.probing()).toBe(false);
    probe(two, 60, 1);
    expect(two.smooth()).toBe(false);
  });

  test("a 30 Hz rAF (battery saver) keeps Basic, however cheap the renders", () => {
    const tier = createTier(capable);
    probe(tier, 30, 1, 33.3);
    expect(tier.smooth()).toBe(false);
  });

  test("rAF intervals over 1 s (a tab coming back) are ignored", () => {
    const tier = createTier(capable);
    for (let i = 0; i < 30; i++) {
      tier.interval(i % 3 === 0 ? 5000 : 16.7);
      tier.interval(16.7);
      tier.work(2, false);
    }
    expect(tier.smooth()).toBe(true);
  });
});

describe("drop for the session", () => {
  test("p95 work over 10 ms across the last 120 Smooth walking renders drops to Basic, and it stays there", () => {
    const tier = smoothTier();
    for (let i = 0; i < 114; i++) tier.work(4, true);
    for (let i = 0; i < 6; i++) tier.work(12, true); // 6 of 120: the 95th percentile is still 4 ms
    expect(tier.smooth()).toBe(true);
    tier.work(12, true); // 7 of the last 120 over 10 ms
    expect(tier.smooth()).toBe(false);
    probe(tier, 60, 1);
    for (let i = 0; i < 200; i++) tier.work(1, true);
    expect(tier.smooth()).toBe(false);
  });

  test("only the last 120 count, and only frames where Smooth drew a walk", () => {
    const tier = smoothTier();
    for (let i = 0; i < 6; i++) tier.work(12, true);
    for (let i = 0; i < 120; i++) tier.work(4, true);
    tier.work(12, true);
    for (let i = 0; i < 50; i++) tier.work(30, false); // at rest: breathe renders, not Smooth's cost
    expect(tier.smooth()).toBe(true);
  });

  test("more than 5 % of walking rAF intervals late (over 1.5 × the median) across 5 s drops to Basic", () => {
    const tier = smoothTier();
    // 5 s at 60 Hz ≈ 300 intervals; one late in 25 (4 %) is fine.
    for (let i = 0; i < 300; i++) tier.interval(i % 25 === 0 ? 33.3 : 16.7);
    expect(tier.smooth()).toBe(true);
    for (let i = 0; i < 300; i++) tier.interval(i % 10 === 0 ? 33.3 : 16.7); // 10 %
    expect(tier.smooth()).toBe(false);
  });

  test("late is relative to the median, so a 120 Hz screen is judged at its own rate; a 2 s gap counts for nothing", () => {
    const tier = smoothTier();
    for (let i = 0; i < 600; i++) tier.interval(i % 25 === 0 ? 2000 : i % 30 === 0 ? 16.7 : 8.3);
    expect(tier.smooth()).toBe(true);
    for (let i = 0; i < 600; i++) tier.interval(i % 8 === 0 ? 16.7 : 8.3);
    expect(tier.smooth()).toBe(false);
  });
});

describe("parseForcedTier and readTierHints (the boundary)", () => {
  test("localStorage['omega.motion'] forces smooth or basic; anything else is ignored", () => {
    expect(parseForcedTier("smooth")).toBe("smooth");
    expect(parseForcedTier("basic")).toBe("basic");
    for (const junk of [null, undefined, "", "Smooth", "fast", 1, {}]) expect(parseForcedTier(junk)).toBeNull();
  });

  test("reads the device hints, and a missing or odd navigator field counts as not reported", () => {
    const store = new Map([["omega.motion", "basic"]]);
    const h = readTierHints({
      reducedMotion: false,
      navigator: { hardwareConcurrency: 4, deviceMemory: 2, connection: { saveData: true } },
      storage: { getItem: (k) => store.get(k) ?? null },
    });
    expect(h).toEqual({ forced: "basic", reducedMotion: false, saveData: true, hardwareConcurrency: 4, deviceMemory: 2 });
    const bare = readTierHints({ reducedMotion: true, navigator: { deviceMemory: "lots" }, storage: null });
    expect(bare).toEqual({ forced: null, reducedMotion: true, saveData: false, hardwareConcurrency: undefined, deviceMemory: undefined });
  });

  test("a storage that throws (blocked cookies) forces nothing", () => {
    const h = readTierHints({
      reducedMotion: false,
      navigator: {},
      storage: {
        getItem: () => {
          throw new Error("SecurityError");
        },
      },
    });
    expect(h.forced).toBeNull();
  });
});

describe("createTierProbe: post-render work and rAF intervals", () => {
  function rig(tier = createTier(capable)) {
    let now = 0;
    const rafs: ((t: number) => void)[] = [];
    let onmessage: (() => void) | null = null;
    let posted = 0;
    let channels = 0;
    const p = createTierProbe(tier, {
      now: () => now,
      raf: (fn) => {
        rafs.push(fn);
      },
      channel: () => {
        channels++;
        return {
          port1: {
            set onmessage(fn: (() => void) | null) {
              onmessage = fn;
            },
          },
          port2: {
            postMessage: () => {
              posted++;
            },
          },
        };
      },
    });
    return {
      p,
      tier,
      at: (t: number) => {
        now = t;
      },
      deliver: () => {
        onmessage?.();
      },
      rafs,
      posted: () => posted,
      channels: () => channels,
    };
  }

  test("work is the time from the frame's start to a message posted after render (paint and raster included)", () => {
    const r = rig();
    for (let i = 0; i < 30; i++) {
      const start = i * 150;
      r.at(start + 1);
      r.p.rendered(start, start, false);
      r.at(start + 3); // 3 ms after the frame started
      r.deliver();
      const next = r.rafs.shift();
      next?.(start + 16.7);
    }
    expect(r.channels()).toBe(1);
    expect(r.posted()).toBe(30);
    expect(r.tier.smooth()).toBe(true);
  });

  test("slow post-render work keeps Basic", () => {
    const r = rig();
    for (let i = 0; i < 30; i++) {
      const start = i * 150;
      r.p.rendered(start, start, false);
      r.at(start + 12);
      r.deliver();
      r.rafs.shift()?.(start + 16.7);
    }
    expect(r.tier.smooth()).toBe(false);
    expect(r.tier.probing()).toBe(false);
  });

  test("once settled in Basic it posts nothing and asks for no frames", () => {
    const r = rig(createTier({ ...capable, saveData: true }));
    r.p.rendered(0, 0, false);
    expect(r.posted()).toBe(0);
    expect(r.rafs.length).toBe(0);
  });

  test("in Smooth, consecutive walking frames give the rAF intervals; a frame at rest breaks the chain", () => {
    const tier = createTier(capable);
    const r = rig(tier);
    for (let i = 0; i < 30; i++) {
      r.p.rendered(i * 150, i * 150, false);
      r.at(i * 150 + 2);
      r.deliver();
      r.rafs.shift()?.(i * 150 + 16.7);
    }
    expect(tier.smooth()).toBe(true);
    // 5 s of walking where every other frame is late: dropped.
    let t = 10_000;
    for (let i = 0; i < 400; i++) {
      t += i % 2 ? 33.3 : 16.7;
      r.p.rendered(t, t, true);
      r.at(t + 2);
      r.deliver();
    }
    expect(r.rafs.length).toBe(0); // no extra frames in Smooth
    expect(tier.smooth()).toBe(false);
  });
});
