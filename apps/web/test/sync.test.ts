import { describe, expect, test } from "bun:test";
import { playbackCaps, type Embed, type PlaybackCaps, type PlaybackState } from "@omega/shared";
import type { PlayerState } from "../src/player/adapter";
import {
  PARK_LEAD_MS,
  SYNC_INTERVAL_MS,
  createSyncLoop,
  decide,
  expectedPosition,
  initialRateMode,
  nextRateMode,
  updateSeekLatency,
  type Correction,
  type DecideInput,
  type RateMode,
} from "../src/sync";
import { FakePlayer, type FakePlayerOptions } from "./support/fake-player";

const ALL_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

const EMBEDS = {
  youtube: { provider: "youtube", videoId: "dQw4w9WgXcQ", url: "https://www.youtube.com/embed/dQw4w9WgXcQ" },
  vimeo: { provider: "vimeo", videoId: "76979871", hash: null, url: "https://player.vimeo.com/video/76979871" },
  twitchVod: { provider: "twitch", kind: "vod", videoId: "1234567890", url: "https://player.twitch.tv/?video=v1234567890" },
  twitchLive: { provider: "twitch", kind: "live", channel: "some_streamer", url: "https://player.twitch.tv/?channel=some_streamer" },
} satisfies Record<string, Embed>;
const CAPS = {
  youtube: playbackCaps(EMBEDS.youtube),
  vimeo: playbackCaps(EMBEDS.vimeo),
  twitchVod: playbackCaps(EMBEDS.twitchVod),
  twitchLive: playbackCaps(EMBEDS.twitchLive),
} satisfies Record<string, PlaybackCaps>;

function room(over: Partial<PlaybackState> = {}): PlaybackState {
  return { playing: true, position: 10, rate: 1, at: 1_000_000, rev: 1, action: "play", by: null, ...over };
}

/** Room expects 10 s at serverNow; player is `driftMs` ahead (+) or behind (-), stable, 3 equal samples. */
function input(driftMs: number, over: Partial<DecideInput> = {}): DecideInput {
  return {
    room: room(),
    serverNowMs: 1_000_000,
    playerTime: 10 + driftMs / 1000,
    playerState: "playing",
    stableForMs: 1000,
    samples: [driftMs, driftMs, driftMs],
    sampleCount: 3,
    lastDriftMs: driftMs,
    hardSeek: false,
    rate: 1,
    mode: "fine",
    seekLatencyMs: 0,
    startLatencyMs: 0,
    parkAt: -1,
    ...over,
  };
}

function rateOf(c: Correction): number {
  if (c.kind !== "rate") throw new Error(`expected a rate correction, got ${c.kind}`);
  return c.rate;
}

describe("expectedPosition", () => {
  test("extrapolates while playing, holds while paused, never goes below 0", () => {
    expect(expectedPosition(room(), 1_002_500)).toBeCloseTo(12.5, 9);
    expect(expectedPosition(room({ rate: 2 }), 1_001_000)).toBeCloseTo(12, 9);
    expect(expectedPosition(room({ playing: false }), 1_009_000)).toBe(10);
    expect(expectedPosition(room({ position: 0.1 }), 999_000)).toBe(0);
  });
});

describe("decide: thresholds", () => {
  test("inside the ±100 ms dead band nothing happens", () => {
    for (const d of [0, 50, -50, 99, -99, 100, -100]) expect(decide(input(d))).toEqual({ kind: "none" });
  });

  test("steady-state 'none' is one shared constant (no allocation per tick)", () => {
    expect(decide(input(0))).toBe(decide(input(20)));
  });

  test("100 ms – 1 s: rate nudge on YouTube's 0.05 grid — ±0.05 up to 250 ms, ±0.1 above; ahead slows down, behind speeds up", () => {
    const table: [number, number][] = [
      [101, 0.95],
      [-101, 1.05],
      [200, 0.95],
      [-200, 1.05],
      [250, 0.95],
      [-250, 1.05],
      [251, 0.9],
      [-400, 1.1],
      [500, 0.9],
      [-500, 1.1],
      [800, 0.9],
      [-1000, 1.1],
      [1000, 0.9],
    ];
    for (const [d, r] of table) expect(rateOf(decide(input(d)))).toBe(r);
  });

  test("above 1 s: seek to the expected position", () => {
    expect(decide(input(1001))).toEqual({ kind: "seek", to: 10, play: true });
    expect(decide(input(-3000))).toEqual({ kind: "seek", to: 10, play: true });
  });

  test("seek-only corrects above 250 ms, half the 500 ms pairwise budget, so two clients can't sit 500+ ms apart (OME-392)", () => {
    expect(decide(input(251, { mode: "seek-only" })).kind).toBe("park");
    expect(decide(input(-251, { mode: "seek-only" })).kind).toBe("park");
    expect(decide(input(250, { mode: "seek-only" }))).toEqual({ kind: "none" });
    expect(decide(input(-250, { mode: "seek-only" }))).toEqual({ kind: "none" });
  });

  test("a nudge in the right direction is held until drift is back inside the dead band", () => {
    expect(decide(input(300, { rate: 0.96 }))).toEqual({ kind: "none" });
    expect(decide(input(-300, { rate: 1.04 }))).toEqual({ kind: "none" });
  });

  test("a nudge in the wrong direction is replaced", () => {
    expect(rateOf(decide(input(-300, { rate: 0.96 })))).toBe(1.1);
  });

  test("a nudge ends as soon as the newest sample is back in the dead band or has crossed over (no overshoot from median lag)", () => {
    expect(decide(input(150, { rate: 0.97, lastDriftMs: 60 }))).toEqual({ kind: "rate", rate: 1 });
    expect(decide(input(150, { mode: "burst", rate: 0.75, lastDriftMs: -20 }))).toEqual({ kind: "rate", rate: 1 });
    expect(decide(input(-150, { mode: "burst", rate: 1.25, lastDriftMs: 30 }))).toEqual({ kind: "rate", rate: 1 });
    expect(decide(input(150, { rate: 0.97, lastDriftMs: 130 }))).toEqual({ kind: "none" });
  });

  test("a nudge doesn't start when the newest sample disagrees with the median", () => {
    expect(decide(input(200, { lastDriftMs: 50 }))).toEqual({ kind: "none" });
    expect(decide(input(200, { lastDriftMs: -300 }))).toEqual({ kind: "none" });
  });

  test("back inside the dead band the rate returns to 1", () => {
    expect(decide(input(40, { rate: 0.96 }))).toEqual({ kind: "rate", rate: 1 });
  });
});

describe("decide: guards", () => {
  test("no room playback → nothing", () => {
    expect(decide(input(5000, { room: null }))).toEqual({ kind: "none" });
  });

  test("no corrections while buffering or in an ad", () => {
    for (const s of ["buffering", "ad"] as const) {
      expect(decide(input(5000, { playerState: s }))).toEqual({ kind: "none" });
      expect(decide(input(300, { playerState: s }))).toEqual({ kind: "none" });
      expect(decide(input(0, { playerState: s, room: room({ playing: false }) }))).toEqual({ kind: "none" });
    }
  });

  test("stability: drift is only trusted after ≥ 500 ms of playing and 3 samples", () => {
    expect(decide(input(5000, { stableForMs: 499 }))).toEqual({ kind: "none" });
    expect(decide(input(300, { stableForMs: 100 }))).toEqual({ kind: "none" });
    expect(decide(input(5000, { sampleCount: 2 }))).toEqual({ kind: "none" });
    expect(decide(input(5000, { stableForMs: 500 })).kind).toBe("seek");
  });

  test("drift is the median of 3, so one outlier sample does nothing", () => {
    expect(decide(input(0, { samples: [50, 3000, 60] }))).toEqual({ kind: "none" });
    expect(decide(input(0, { samples: [3000, -40, 2900] }))).toEqual({ kind: "seek", to: 10, play: true });
    expect(rateOf(decide(input(0, { samples: [200, -5000, 190], lastDriftMs: 190 })))).toBe(0.95);
  });
});

describe("decide: play state", () => {
  test("room playing, player not playing → play", () => {
    for (const s of ["paused", "unstarted", "cued"] as const) {
      expect(decide(input(0, { playerState: s, stableForMs: 0, sampleCount: 0 }))).toEqual({ kind: "play" });
    }
  });

  test("room playing, player ended → nothing (the video is over)", () => {
    expect(decide(input(0, { playerState: "ended" }))).toEqual({ kind: "none" });
  });

  test("room paused, player playing → pause", () => {
    expect(decide(input(0, { room: room({ playing: false }) }))).toEqual({ kind: "pause" });
  });

  test("room paused, player paused: a > 250 ms difference seeks in every mode (half the pairwise budget), and it stays paused (OME-396)", () => {
    const paused = room({ playing: false });
    for (const mode of ["fine", "burst", "seek-only"] as const) {
      expect(decide(input(250, { mode, room: paused, playerState: "paused" }))).toEqual({ kind: "none" });
      expect(decide(input(-250, { mode, room: paused, playerState: "paused" }))).toEqual({ kind: "none" });
      expect(decide(input(251, { mode, room: paused, playerState: "paused" }))).toEqual({ kind: "seek", to: 10, play: false });
      expect(decide(input(-600, { mode, room: paused, playerState: "paused" }))).toEqual({ kind: "seek", to: 10, play: false });
    }
  });
});

describe("decide: hard seek", () => {
  test("an explicit action/join/embed change seeks even inside the dead band and without stable samples", () => {
    expect(decide(input(0, { hardSeek: true, stableForMs: 0, sampleCount: 0 }))).toEqual({ kind: "seek", to: 10, play: true });
    expect(decide(input(0, { hardSeek: true, playerState: "cued" }))).toEqual({ kind: "seek", to: 10, play: true });
    expect(decide(input(0, { hardSeek: true, room: room({ playing: false }) }))).toEqual({ kind: "seek", to: 10, play: false });
  });

  test("a hard seek goes through while buffering (the user moved), but waits out an ad", () => {
    expect(decide(input(0, { hardSeek: true, playerState: "buffering" })).kind).toBe("seek");
    expect(decide(input(0, { hardSeek: true, playerState: "ad" }))).toEqual({ kind: "none" });
  });

  test("seek-latency compensation lands ahead by the estimated latency, only while playing", () => {
    const c = decide(input(0, { hardSeek: true, seekLatencyMs: 250 }));
    expect(c.kind).toBe("seek");
    if (c.kind === "seek") expect(c.to).toBeCloseTo(10.25, 9);
    expect(decide(input(0, { hardSeek: true, seekLatencyMs: 250, room: room({ playing: false }) }))).toEqual({
      kind: "seek",
      to: 10,
      play: false,
    });
  });
});

describe("decide: start-up latency (OME-392)", () => {
  test("a hard seek on a paused player aims ahead by the start-up latency; a cold player (cued, unstarted) doesn't, since it isn't learned from them", () => {
    const at = (playerState: PlayerState) => decide(input(0, { hardSeek: true, playerState, startLatencyMs: 800, seekLatencyMs: 200 }));
    expect(at("paused")).toEqual({ kind: "seek", to: 10.8, play: true });
    expect(at("cued")).toEqual({ kind: "seek", to: 10, play: true });
    expect(at("unstarted")).toEqual({ kind: "seek", to: 10, play: true });
    expect(at("playing")).toEqual({ kind: "seek", to: 10.2, play: true });
  });
});

describe("decide: seek-only parks instead of seeking while playing (OME-396)", () => {
  test("a park seeks paused to the room + PARK_LEAD_MS + the start-up latency, so the play can land on the room clock", () => {
    expect(PARK_LEAD_MS).toBe(1000);
    expect(decide(input(-3000, { mode: "seek-only" }))).toEqual({ kind: "park", to: 11 });
    expect(decide(input(700, { mode: "seek-only", startLatencyMs: 60 }))).toEqual({ kind: "park", to: 11.06 });
    expect(decide(input(-400, { mode: "seek-only", room: room({ rate: 2 }) }))).toEqual({ kind: "park", to: 12 });
  });

  test("a hard seek parks a playing or buffering player, and a paused one far from the room", () => {
    expect(decide(input(0, { mode: "seek-only", hardSeek: true }))).toEqual({ kind: "park", to: 11 });
    expect(decide(input(0, { mode: "seek-only", hardSeek: true, playerState: "buffering" }))).toEqual({ kind: "park", to: 11 });
    expect(decide(input(-251, { mode: "seek-only", hardSeek: true, playerState: "paused" }))).toEqual({ kind: "park", to: 11 });
  });

  test("a resume near the room just plays: the paused player is already there, and a seek would drop its buffer; a cold join still seeks", () => {
    expect(decide(input(-250, { mode: "seek-only", hardSeek: true, playerState: "paused", startLatencyMs: 60 }))).toEqual({ kind: "play" });
    expect(decide(input(0, { mode: "seek-only", hardSeek: true, playerState: "cued" }))).toEqual({ kind: "seek", to: 10, play: true });
  });

  test("parked: wait while the room is more than half a tick (+ start-up latency) away, then unpark", () => {
    const parked = (parkAt: number, over: Partial<DecideInput> = {}) =>
      decide(input(0, { mode: "seek-only", playerState: "paused", stableForMs: 0, sampleCount: 0, parkAt, ...over }));
    expect(parked(11)).toEqual({ kind: "none" });
    expect(parked(10.126)).toEqual({ kind: "none" });
    expect(parked(10.125)).toEqual({ kind: "unpark" });
    expect(parked(9)).toEqual({ kind: "unpark" });
    expect(parked(10.2, { startLatencyMs: 80 })).toEqual({ kind: "unpark" });
    // The pause may not show yet: still wait.
    expect(parked(11, { playerState: "playing" })).toEqual({ kind: "none" });
    expect(parked(10.1, { playerState: "playing" })).toEqual({ kind: "unpark" });
    expect(parked(11, { playerState: "buffering" })).toEqual({ kind: "none" });
  });

  test("fine and burst still seek while playing", () => {
    expect(decide(input(-3000)).kind).toBe("seek");
    expect(decide(input(-3000, { mode: "burst" })).kind).toBe("seek");
    expect(decide(input(0, { hardSeek: true })).kind).toBe("seek");
  });
});

describe("decide: fallback ladder", () => {
  test("burst mode nudges with 0.75 / 1.25", () => {
    expect(decide(input(300, { mode: "burst" }))).toEqual({ kind: "rate", rate: 0.75 });
    expect(decide(input(-300, { mode: "burst" }))).toEqual({ kind: "rate", rate: 1.25 });
    expect(decide(input(-300, { mode: "burst", rate: 1.25 }))).toEqual({ kind: "none" });
    expect(decide(input(1500, { mode: "burst" })).kind).toBe("seek");
  });

  test("seek-only mode never changes rate and parks above 250 ms", () => {
    expect(decide(input(200, { mode: "seek-only" }))).toEqual({ kind: "none" });
    expect(decide(input(-251, { mode: "seek-only" }))).toEqual({ kind: "park", to: 11 });
    expect(decide(input(200, { mode: "seek-only", rate: 1.04 }))).toEqual({ kind: "rate", rate: 1 });
  });

  test("initial mode: fine rates unless the player only offers 1×", () => {
    expect(initialRateMode(ALL_RATES, CAPS.youtube)).toBe("fine");
    expect(initialRateMode([1], CAPS.youtube)).toBe("seek-only");
    expect(initialRateMode([], CAPS.youtube)).toBe("seek-only");
  });

  test("effective-rate check steps down fine → burst → seek-only", () => {
    const table: [RateMode, number, number, readonly number[], RateMode][] = [
      ["fine", 1.05, 1.049, ALL_RATES, "fine"],
      ["fine", 0.95, 0.951, ALL_RATES, "fine"],
      ["fine", 1.05, 1.004, ALL_RATES, "burst"],
      ["fine", 0.95, 0.995, ALL_RATES, "burst"],
      ["fine", 1.05, 1.0, [0.5, 1, 2], "seek-only"],
      ["fine", 1.1, 1.03, ALL_RATES, "burst"],
      ["fine", 1.1, 1.06, ALL_RATES, "fine"],
      ["burst", 1.25, 1.24, ALL_RATES, "burst"],
      ["burst", 1.25, 1.0, ALL_RATES, "seek-only"],
      ["seek-only", 1, 1, ALL_RATES, "seek-only"],
      ["live", 1.05, 1.0, ALL_RATES, "live"],
    ];
    for (const [mode, requested, slope, rates, next] of table) expect(nextRateMode(mode, requested, slope, rates)).toBe(next);
  });
});

describe("capabilities (ADR 0014 §3, research §6.3)", () => {
  test("initial mode per embed: rate caps pick the rung, live picks the live mode", () => {
    const table: [string, PlaybackCaps, readonly number[], RateMode][] = [
      ["YouTube", CAPS.youtube, ALL_RATES, "fine"],
      ["Vimeo, rate probe OK", CAPS.vimeo, ALL_RATES, "fine"],
      ["Vimeo, rate probe rejected", CAPS.vimeo, [1], "seek-only"],
      // Twitch never sets a rate, even if a player claims it could.
      ["Twitch VOD", CAPS.twitchVod, ALL_RATES, "seek-only"],
      ["Twitch VOD, 1× only", CAPS.twitchVod, [1], "seek-only"],
      ["Twitch live", CAPS.twitchLive, [1], "live"],
      ["Twitch live, rates claimed", CAPS.twitchLive, ALL_RATES, "live"],
      ["no seek without live", { seek: false, live: false, rate: "yes" }, ALL_RATES, "live"],
    ];
    for (const [name, caps, rates, mode] of table) expect([name, initialRateMode(rates, caps)]).toEqual([name, mode]);
  });

  // Each row: mode, scenario → correction. The same scenarios for every mode, so the table shows what each capability set gives up.
  const scenarios: [string, Partial<DecideInput> & { drift: number }][] = [
    ["in the dead band", { drift: 50 }],
    ["200 ms ahead", { drift: 200 }],
    ["200 ms behind", { drift: -200 }],
    ["700 ms ahead", { drift: 700 }],
    ["3 s behind", { drift: -3000 }],
    ["hard seek (join, explicit action)", { drift: 0, hardSeek: true }],
    ["hard seek while paused here", { drift: 0, hardSeek: true, playerState: "paused" }],
    ["room paused, player playing", { drift: 0, room: room({ playing: false }) }],
    ["room paused, player paused 5 s away", { drift: 5000, room: room({ playing: false }), playerState: "paused" }],
    ["room playing, player paused", { drift: 0, playerState: "paused", stableForMs: 0, sampleCount: 0 }],
    ["buffering, 3 s behind", { drift: -3000, playerState: "buffering" }],
    ["ad", { drift: 0, playerState: "ad" }],
  ];
  const expected: Record<RateMode, Correction[]> = {
    fine: [
      { kind: "none" },
      { kind: "rate", rate: 0.95 },
      { kind: "rate", rate: 1.05 },
      { kind: "rate", rate: 0.9 },
      { kind: "seek", to: 10, play: true },
      { kind: "seek", to: 10, play: true },
      { kind: "seek", to: 10, play: true },
      { kind: "pause" },
      { kind: "seek", to: 10, play: false },
      { kind: "play" },
      { kind: "none" },
      { kind: "none" },
    ],
    "seek-only": [
      { kind: "none" },
      { kind: "none" },
      { kind: "none" },
      { kind: "park", to: 11 },
      { kind: "park", to: 11 },
      { kind: "park", to: 11 },
      { kind: "play" },
      { kind: "pause" },
      { kind: "seek", to: 10, play: false },
      { kind: "play" },
      { kind: "none" },
      { kind: "none" },
    ],
    burst: [
      { kind: "none" },
      { kind: "rate", rate: 0.75 },
      { kind: "rate", rate: 1.25 },
      { kind: "rate", rate: 0.75 },
      { kind: "seek", to: 10, play: true },
      { kind: "seek", to: 10, play: true },
      { kind: "seek", to: 10, play: true },
      { kind: "pause" },
      { kind: "seek", to: 10, play: false },
      { kind: "play" },
      { kind: "none" },
      { kind: "none" },
    ],
    // Play/pause only: never a seek or a rate, whatever the drift. A hard seek becomes "match play/pause" (play = back to the live edge).
    live: [
      { kind: "none" },
      { kind: "none" },
      { kind: "none" },
      { kind: "none" },
      { kind: "none" },
      { kind: "none" },
      { kind: "play" },
      { kind: "pause" },
      { kind: "none" },
      { kind: "play" },
      { kind: "none" },
      { kind: "none" },
    ],
  };
  for (const mode of ["fine", "burst", "seek-only", "live"] as const) {
    test(`decide table: ${mode}`, () => {
      const got: unknown[][] = scenarios.map(([name, { drift, ...over }]) => [name, decide(input(drift, { mode, ...over }))]);
      const want = scenarios.map(([name], i) => [name, expected[mode][i]]);
      expect(got).toEqual(want);
    });
  }

  test("live: a leftover rate from a previous embed is reset to 1×, then nothing", () => {
    expect(decide(input(300, { mode: "live", rate: 1.05 }))).toEqual({ kind: "rate", rate: 1 });
  });
});

describe("updateSeekLatency (EWMA)", () => {
  test("a seek that lands behind raises the estimate; clamped to 0–2000 ms", () => {
    expect(updateSeekLatency(0, 0, -400)).toBeCloseTo(100, 9);
    expect(updateSeekLatency(100, 100, 0)).toBeCloseTo(100, 9);
    expect(updateSeekLatency(100, 100, 200)).toBeCloseTo(75, 9);
    expect(updateSeekLatency(0, 0, -10_000)).toBeCloseTo(500, 9);
    expect(updateSeekLatency(0, 0, 5000)).toBe(0);
  });
});

// --- the loop -------------------------------------------------------------

interface Harness {
  t: { now: number };
  clock: { ready: boolean; serverNow(): number };
  player: FakePlayer;
  loop: ReturnType<typeof createSyncLoop>;
  timers: { fn: () => void; ms: number; cleared: boolean }[];
  run(ms: number): void;
}

function harness(opts: Omit<Partial<FakePlayerOptions>, "now"> = {}): Harness {
  const t = { now: 0 };
  // server clock = client clock + 1_000_000 ms
  const clock = { ready: true, serverNow: () => t.now + 1_000_000 };
  const player = new FakePlayer({ now: () => t.now, state: "playing", position: 10, ...opts });
  const timers: Harness["timers"] = [];
  const loop = createSyncLoop({
    player,
    clock,
    now: () => t.now,
    setInterval: (fn, ms) => {
      const h = { fn, ms, cleared: false };
      timers.push(h);
      return h;
    },
    clearInterval: (h) => {
      h.cleared = true;
    },
  });
  const run = (ms: number) => {
    for (let i = 0; i < ms / SYNC_INTERVAL_MS; i++) {
      t.now += SYNC_INTERVAL_MS;
      for (const h of timers) if (!h.cleared) h.fn();
    }
  };
  return { t, clock, player, loop, timers, run };
}

describe("sync loop", () => {
  test("live player (Twitch live): join plays without a seek, and drift never seeks or nudges", () => {
    const h = harness({ caps: CAPS.twitchLive, rates: [1], state: "cued", position: 0 });
    h.loop.start();
    h.loop.setPlayback(room({ position: 0 }));
    h.run(250);
    expect(h.loop.mode).toBe("live");
    expect(h.player.calls).toEqual([{ op: "play" }]);
    h.player.shift(-30);
    h.run(5000);
    expect(h.player.calls).toEqual([{ op: "play" }]);
    h.loop.setPlayback(room({ rev: 2, action: "pause", playing: false, position: 0, at: h.clock.serverNow() }));
    h.run(250);
    expect(h.player.calls).toEqual([{ op: "play" }, { op: "pause" }]);
  });

  test("a new room state goes out on the next tick even within RESEND_MS of the loop's own play (OME-170)", () => {
    const h = harness({ caps: CAPS.twitchLive, rates: [1], state: "cued", position: 0 });
    h.loop.start();
    h.loop.setPlayback(room({ position: 0 }));
    h.run(250);
    expect(h.player.calls).toEqual([{ op: "play" }]);
    h.loop.setPlayback(room({ rev: 2, action: "pause", playing: false, position: 0, at: h.clock.serverNow() }));
    h.run(250);
    expect(h.player.calls).toEqual([{ op: "play" }, { op: "pause" }]);
    // 500 ms after the loop's own play: the room resumes; it must not wait out RESEND_MS.
    h.loop.setPlayback(room({ rev: 3, action: "play", playing: true, position: 0, at: h.clock.serverNow() }));
    h.run(250);
    expect(h.player.calls).toEqual([{ op: "play" }, { op: "pause" }, { op: "play" }]);
  });

  test("seek-only: drift parks once (seek paused, play when the room gets there) and lands on the room clock, without the stall a seek while playing has (OME-396)", () => {
    const h = harness({ caps: CAPS.twitchVod, rates: [1], seekLatencyMs: 1500 });
    h.loop.start();
    h.loop.setPlayback(room({ at: 1_000_000 }));
    h.run(3000);
    h.player.calls.length = 0;
    h.player.shift(-2);
    h.run(1000);
    expect(h.player.calls).toEqual([
      { op: "seek", to: expect.closeTo(expectedPosition(room(), h.clock.serverNow()) + 0.5, 6) as number },
      { op: "pause" },
    ]);
    expect(h.player.state()).toBe("paused");
    h.run(10_000);
    expect(h.player.calls.map((c) => c.op)).toEqual(["seek", "pause", "play"]);
    expect(h.player.state()).toBe("playing");
    expect(Math.abs(h.player.time() - expectedPosition(room(), h.clock.serverNow()))).toBeLessThanOrEqual(0.01);
  });

  test("seek-only: a park learns the start-up latency, so the next one lands on the room clock (OME-396)", () => {
    const h = harness({ caps: CAPS.twitchVod, rates: [1], startLatencyMs: 60 });
    h.loop.start();
    h.loop.setPlayback(room({ at: 1_000_000 }));
    h.run(5000);
    expect(h.loop.startLatencyMs).toBeCloseTo(60, 6);
    h.player.shift(1);
    h.run(10_000);
    expect(h.player.calls.filter((c) => c.op === "seek")).toHaveLength(2);
    expect(Math.abs(h.player.time() - expectedPosition(room(), h.clock.serverNow()))).toBeLessThanOrEqual(0.01);
  });

  test("seek-only: a resume plays without a seek and isn't parked on the next tick (OME-396)", () => {
    const h = harness({ caps: CAPS.twitchVod, rates: [1], state: "paused" });
    h.loop.start();
    h.loop.setPlayback(room({ playing: false, action: "pause", at: h.clock.serverNow() }));
    h.run(500);
    h.player.calls.length = 0;
    const resumed = room({ rev: 2, at: h.clock.serverNow() });
    h.loop.setPlayback(resumed);
    h.run(5000);
    expect(h.player.calls).toEqual([{ op: "play" }]);
    expect(Math.abs(h.player.time() - expectedPosition(resumed, h.clock.serverNow()))).toBeLessThanOrEqual(0.25);
  });

  test("seek-only: a new room state while parked cancels the park", () => {
    const h = harness({ caps: CAPS.twitchVod, rates: [1] });
    h.loop.start();
    h.loop.setPlayback(room({ at: 1_000_000 }));
    h.run(250);
    expect(h.player.calls.map((c) => c.op)).toEqual(["seek", "pause"]);
    h.loop.setPlayback(room({ rev: 2, action: "pause", playing: false, position: 10.25, at: h.clock.serverNow() }));
    h.run(3000);
    expect(h.player.calls.map((c) => c.op)).toEqual(["seek", "pause", "seek", "pause"]);
    expect(h.player.state()).toBe("paused");
  });

  test("Twitch VOD: seek-only from the start even if the player lists rates", () => {
    const h = harness({ caps: CAPS.twitchVod });
    h.loop.start();
    h.loop.setPlayback(room({ at: 1_000_000 }));
    // The join parks a playing player; let it play again first.
    h.run(2000);
    h.player.calls.length = 0;
    h.player.shift(0.2);
    h.run(3000);
    expect(h.loop.mode).toBe("seek-only");
    expect(h.player.calls).toEqual([]);
    h.player.shift(0.1);
    h.run(3000);
    expect(h.player.calls.some((c) => c.op === "rate")).toBe(false);
    expect(h.player.calls[0]?.op).toBe("seek");
  });

  test("runs on its own 250 ms interval; stop() clears it", () => {
    const h = harness();
    h.loop.start();
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0]?.ms).toBe(250);
    h.loop.stop();
    expect(h.timers[0]?.cleared).toBe(true);
  });

  test("idle until the clock is ready", () => {
    const h = harness();
    h.clock.ready = false;
    h.loop.start();
    h.loop.setPlayback(room({ at: 1_000_000 }));
    h.run(2000);
    expect(h.player.calls).toEqual([]);
    h.clock.ready = true;
    h.run(250);
    expect(h.player.calls[0]?.op).toBe("seek");
  });

  test("idle until the player is ready, and with no playback", () => {
    const h = harness({ ready: false });
    h.loop.start();
    h.loop.setPlayback(room());
    h.run(1000);
    expect(h.player.calls).toEqual([]);
    h.player.isReady = true;
    h.loop.setPlayback(null);
    h.run(1000);
    expect(h.player.calls).toEqual([]);
  });

  test("join hard-seeks to the room position and plays", () => {
    const h = harness({ state: "cued", position: 0 });
    h.loop.start();
    // room: 10 s at server 1_000_000, playing → at client t=250 expect 10.25 s
    h.loop.setPlayback(room());
    h.run(250);
    expect(h.player.calls.slice(0, 2)).toEqual([{ op: "seek", to: 10.25 }, { op: "play" }]);
  });

  test("a new playback state (explicit action) hard-seeks; steady state then makes no calls", () => {
    const h = harness();
    h.loop.start();
    h.loop.setPlayback(room({ at: 1_000_000 }));
    h.run(250);
    h.player.calls.length = 0;
    h.run(3000);
    expect(h.player.calls).toEqual([]);
    h.loop.setPlayback(room({ rev: 2, action: "seek", position: 60, at: h.clock.serverNow() }));
    h.run(250);
    expect(h.player.calls[0]).toEqual({ op: "seek", to: 60.25 });
  });

  test("a small drift is nudged with the playback rate and closes", () => {
    const h = harness();
    h.loop.start();
    h.loop.setPlayback(room({ at: 1_000_000 }));
    h.run(250);
    h.player.shift(-0.4); // 400 ms behind
    h.player.calls.length = 0;
    h.run(1500);
    const first = h.player.calls[0];
    expect(first?.op).toBe("rate");
    if (first?.op === "rate") expect(first.rate).toBeGreaterThan(1);
    h.run(15_000);
    expect(h.player.calls.at(-1)).toEqual({ op: "rate", rate: 1 });
    expect(h.loop.mode).toBe("fine");
    expect(Math.abs(h.player.time() - expectedPosition(room({ at: 1_000_000 }), h.clock.serverNow()))).toBeLessThanOrEqual(0.1);
  });

  // YouTube floors setPlaybackRate to 0.05 steps (OME-109): 1.02 and 1.03 play at 1×, 0.98 at 0.95.
  for (const drift of [-0.12, -0.2, 0.15, -0.4, 0.6]) {
    test(`on a player with a 0.05 rate step, fine nudges apply and stay on "fine" (drift ${String(drift)} s)`, () => {
      const h = harness({ rateStep: 0.05 });
      h.loop.start();
      h.loop.setPlayback(room({ at: 1_000_000 }));
      h.run(250);
      h.player.shift(drift);
      h.player.calls.length = 0;
      h.run(15_000);
      expect(h.loop.mode).toBe("fine");
      const rates = h.player.calls.flatMap((c) => (c.op === "rate" ? [c.rate] : []));
      expect(rates.some((r) => r !== 1)).toBe(true);
      expect(rates.filter((r) => ![0.9, 0.95, 1, 1.05, 1.1].includes(r))).toEqual([]);
      expect(Math.abs(h.player.time() - expectedPosition(room({ at: 1_000_000 }), h.clock.serverNow()))).toBeLessThanOrEqual(0.1);
    });
  }

  test("fine rates that aren't really applied fall back to 0.75/1.25 bursts", () => {
    const h = harness({ applies: (r) => r === 1 || r === 0.75 || r === 1.25 });
    h.loop.start();
    h.loop.setPlayback(room({ at: 1_000_000 }));
    h.run(250);
    h.player.shift(-0.6);
    h.run(6000);
    expect(h.loop.mode).toBe("burst");
    const rates = h.player.calls.flatMap((c) => (c.op === "rate" ? [c.rate] : []));
    expect(rates).toContain(1.25);
    h.run(10_000);
    expect(Math.abs(h.player.time() - expectedPosition(room({ at: 1_000_000 }), h.clock.serverNow()))).toBeLessThanOrEqual(0.1);
  });

  test("a player that only offers 1× runs seek-only", () => {
    const h = harness({ rates: [1] });
    h.loop.start();
    h.loop.setPlayback(room({ at: 1_000_000 }));
    // The join parks a playing player; let it play again first.
    h.run(2000);
    expect(h.loop.mode).toBe("seek-only");
    h.player.shift(-0.7);
    h.player.calls.length = 0;
    h.run(2000);
    expect(h.player.calls.some((c) => c.op === "rate")).toBe(false);
    expect(h.player.calls.some((c) => c.op === "seek")).toBe(true);
  });

  test("buffering makes no corrections", () => {
    const h = harness();
    h.loop.start();
    h.loop.setPlayback(room({ at: 1_000_000 }));
    h.run(250);
    h.player.calls.length = 0;
    h.player.setState("buffering");
    h.run(3000);
    expect(h.player.calls).toEqual([]);
  });

  test("seek latency is learned: later seeks land closer", () => {
    const h = harness({ seekLatencyMs: 400 });
    h.loop.start();
    h.loop.setPlayback(room({ at: 1_000_000 }));
    h.run(3000);
    expect(h.loop.seekLatencyMs).toBeGreaterThan(0);
    const before = h.loop.seekLatencyMs;
    h.loop.setPlayback(room({ rev: 2, action: "seek", position: 100, at: h.clock.serverNow() }));
    h.run(250);
    const seek = h.player.calls.findLast((c) => c.op === "seek");
    expect(seek?.op).toBe("seek");
    if (seek?.op === "seek") expect(seek.to).toBeCloseTo(100.25 + before / 1000, 6);
  });

  test("a resume learns the player's start-up latency from its first sample; the next resume starts that far ahead and lands on the room (OME-392)", () => {
    const h = harness({ state: "paused", startLatencyMs: 800 });
    h.loop.start();
    h.loop.setPlayback(room({ playing: false, action: "pause", at: h.clock.serverNow() }));
    h.run(250);
    h.loop.setPlayback(room({ rev: 2, at: h.clock.serverNow() }));
    h.run(3000);
    expect(h.loop.startLatencyMs).toBeCloseTo(800, 6);
    // A seek while playing is a different cost: not learned from a resume.
    expect(h.loop.seekLatencyMs).toBe(0);

    h.loop.setPlayback(room({ rev: 3, action: "pause", playing: false, position: h.player.time(), at: h.clock.serverNow() }));
    h.run(500);
    const resumed = room({ rev: 4, position: h.player.time(), at: h.clock.serverNow() });
    h.loop.setPlayback(resumed);
    h.player.calls.length = 0;
    h.run(250);
    const seek = h.player.calls[0];
    expect(seek?.op).toBe("seek");
    if (seek?.op === "seek") expect(seek.to).toBeCloseTo(resumed.position + 0.25 + 0.8, 6);
    h.run(1000);
    expect(h.player.state()).toBe("playing");
    expect(Math.abs(h.player.time() - expectedPosition(resumed, h.clock.serverNow()))).toBeLessThanOrEqual(0.01);
  });

  test("a join (cold player) isn't learned as start-up latency", () => {
    const h = harness({ state: "cued", startLatencyMs: 800 });
    h.loop.start();
    h.loop.setPlayback(room({ at: h.clock.serverNow() }));
    h.run(3000);
    expect(h.loop.startLatencyMs).toBe(0);
  });

  test("after a click-pause intent the loop holds off until the room answers", () => {
    const h = harness();
    h.loop.start();
    h.loop.setPlayback(room({ at: 1_000_000 }));
    h.run(1000);
    h.player.calls.length = 0;
    h.player.setState("paused");
    h.player.emit({ type: "intent", playing: false, position: h.player.time() });
    h.run(750);
    expect(h.player.calls).toEqual([]);
    h.loop.setPlayback(room({ rev: 2, action: "pause", playing: false, position: h.player.time(), at: h.clock.serverNow() }));
    h.run(250);
    expect(h.player.calls.map((c) => c.op)).toEqual(["seek", "pause"]);
  });

  test("an unanswered intent stops holding after 1 s", () => {
    const h = harness();
    h.loop.start();
    h.loop.setPlayback(room({ at: 1_000_000 }));
    h.run(1000);
    h.player.calls.length = 0;
    h.player.setState("paused");
    h.player.emit({ type: "intent", playing: false, position: h.player.time() });
    h.run(1500);
    expect(h.player.calls.some((c) => c.op === "play")).toBe(true);
  });

  test("play is not re-sent every tick while the player is slow to start", () => {
    const h = harness({ state: "cued", ignorePlay: true });
    h.loop.start();
    h.loop.setPlayback(room());
    h.run(2250);
    expect(h.player.calls.filter((c) => c.op === "play").length).toBeLessThanOrEqual(3);
  });

  test("an ad between a seek and its first samples isn't learned as seek latency", () => {
    const h = harness();
    h.loop.start();
    h.loop.setPlayback(room({ at: 1_000_000 }));
    h.run(250);
    h.player.setState("ad");
    h.run(2000);
    h.player.shift(-0.8);
    h.player.setState("playing");
    h.run(2000);
    expect(h.loop.seekLatencyMs).toBe(0);
  });

  test("player state is read by the loop, events are not needed", () => {
    const states: PlayerState[] = [];
    const h = harness();
    h.player.onEvent((e) => {
      if (e.type === "state") states.push(e.state);
    });
    h.loop.start();
    h.loop.setPlayback(room());
    h.run(500);
    expect(states).toEqual([]);
  });
});
