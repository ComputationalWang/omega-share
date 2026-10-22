import { describe, expect, test } from "bun:test";
import type { MemberId, Reaction, ReactionKind } from "@omega/shared";

// OME-1628: "catch me up": a late joiner sees the stored reactions ahead of them replayed as emotes, at their timestamp.

const r = (mediaMs: number, kind: ReactionKind = "heart", id = "m1"): Reaction => ({ memberId: id as MemberId, kind, mediaMs });

/** A fake clock: the video plays from `start` media ms at `rate` while `playing`. */
async function setup(start: number) {
  const { createReplay } = await import("../src/moments/replay");
  let now = 0;
  let media = { at: 0, ms: start, rate: 1, playing: true };
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let nextId = 1;
  const shown: { t: number; mediaMs: number; kind: string }[] = [];
  const position = (): { ms: number; rate: number } | null => (media.playing ? { ms: media.ms + (now - media.at) * media.rate, rate: media.rate } : null);
  const replay = createReplay({
    position,
    show: (id, kind) => shown.push({ t: now, mediaMs: position()?.ms ?? -1, kind: `${id}:${kind}` }),
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.push({ at: now + ms, fn, id });
      return id;
    },
    clearTimeout: (id) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
  });
  const advance = (ms: number): void => {
    const end = now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const t = timers[0];
      if (t === undefined || t.at > end) break;
      timers.shift();
      now = t.at;
      t.fn();
    }
    now = end;
  };
  const setMedia = (ms: number, playing: boolean, rate = 1): void => {
    media = { at: now, ms, rate, playing };
  };
  return { replay, shown, advance, timers, setMedia };
}

describe("createReplay", () => {
  test("reactions ahead of me play at their timestamp, within 500 ms, as emotes", async () => {
    const s = await setup(100_000);
    s.replay.start([r(160_000, "wow"), r(130_000, "laugh")]);
    s.advance(70_000);
    expect(s.shown.map((x) => x.kind)).toEqual(["m1:laugh", "m1:exclaim"]);
    expect(Math.abs((s.shown[0]?.mediaMs ?? 0) - 130_000)).toBeLessThanOrEqual(500);
    expect(Math.abs((s.shown[1]?.mediaMs ?? 0) - 160_000)).toBeLessThanOrEqual(500);
  });

  test("one timer at a time, none once nothing is left", async () => {
    const s = await setup(0);
    s.replay.start([r(10_000), r(20_000), r(30_000)]);
    expect(s.timers).toHaveLength(1);
    s.advance(15_000);
    expect(s.timers).toHaveLength(1);
    s.advance(20_000);
    expect(s.timers).toHaveLength(0);
  });

  test("on arrival, the last 30 s play back quickly; older ones don't", async () => {
    const s = await setup(100_000);
    s.replay.start([r(50_000, "clap"), r(75_000, "heart"), r(90_000, "laugh"), r(99_000, "clap")]);
    s.advance(2000);
    expect(s.shown.map((x) => x.kind)).toEqual(["m1:heart", "m1:laugh", "m1:clap"]);
    expect(Math.max(...s.shown.map((x) => x.t))).toBeLessThan(2000);
  });

  test("the arrival burst is capped at the latest ARRIVAL_MAX", async () => {
    const { ARRIVAL_MAX } = await import("../src/moments/replay");
    const s = await setup(100_000);
    const list = Array.from({ length: 40 }, (_, i) => r(71_000 + i * 500));
    s.replay.start(list);
    s.advance(10_000);
    expect(s.shown).toHaveLength(ARRIVAL_MAX);
  });

  test("paused: nothing plays and no timer runs; play again picks up", async () => {
    const s = await setup(0);
    s.replay.start([r(10_000)]);
    s.setMedia(5000, false);
    s.replay.sync();
    expect(s.timers).toHaveLength(0);
    s.advance(60_000);
    expect(s.shown).toHaveLength(0);
    s.setMedia(5000, true);
    s.replay.sync();
    s.advance(5000);
    expect(s.shown).toHaveLength(1);
  });

  test("a seek back replays what's ahead again; a seek forward skips without a burst", async () => {
    const s = await setup(0);
    s.replay.start([r(10_000)]);
    s.advance(20_000);
    expect(s.shown).toHaveLength(1);
    s.setMedia(5000, true);
    s.replay.sync();
    s.advance(5000);
    expect(s.shown).toHaveLength(2);
    s.setMedia(50_000, true);
    s.replay.sync();
    s.advance(10_000);
    expect(s.shown).toHaveLength(2);
  });

  test("a live reaction is stored for later but not replayed now (the burst shows it)", async () => {
    const s = await setup(0);
    s.replay.start([]);
    s.advance(10_000);
    s.replay.push(r(10_000));
    s.advance(10_000);
    expect(s.shown).toHaveLength(0);
    s.setMedia(9000, true);
    s.replay.sync();
    s.advance(2000);
    expect(s.shown).toHaveLength(1);
  });

  test("at 2× the replay still lands on time", async () => {
    const s = await setup(0);
    s.setMedia(0, true, 2);
    s.replay.start([r(20_000)]);
    s.advance(10_000);
    expect(s.shown).toHaveLength(1);
    expect(Math.abs((s.shown[0]?.mediaMs ?? 0) - 20_000)).toBeLessThanOrEqual(500);
  });

  test("stop clears the timer and the list", async () => {
    const s = await setup(0);
    s.replay.start([r(10_000)]);
    s.replay.stop();
    expect(s.timers).toHaveLength(0);
    s.replay.sync();
    s.advance(20_000);
    expect(s.shown).toHaveLength(0);
  });
});
