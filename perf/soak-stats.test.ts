import { describe, expect, test } from "bun:test";
import {
  BOUNDS,
  evaluate,
  parseMetrics,
  parseSoakArgs,
  slopePerHour,
  StderrTally,
  windowPercentiles,
  type SoakResult,
} from "./soak-stats";

const HOUR = 3_600_000;

describe("slopePerHour", () => {
  test("a straight line", () => {
    const seg = [0, 1, 2, 3].map((i) => ({ tMs: (i * HOUR) / 2, v: 100 + 10 * i }));
    expect(slopePerHour([seg])).toBeCloseTo(20, 9);
  });
  test("flat is zero, too few points is zero", () => {
    expect(slopePerHour([[0, 1, 2].map((i) => ({ tMs: i * 1000, v: 7 }))])).toBe(0);
    expect(slopePerHour([[{ tMs: 0, v: 1 }]])).toBe(0);
    expect(slopePerHour([])).toBe(0);
  });
  test("a restart's drop between segments is not a slope", () => {
    const a = [0, 1, 2].map((i) => ({ tMs: i * 1000, v: 500 + i }));
    const b = [10, 11, 12].map((i) => ({ tMs: i * 1000, v: 100 + (i - 10) }));
    expect(slopePerHour([a, b])).toBeCloseTo(3600, 6); // 1 unit per second in both segments
  });
});

describe("windowPercentiles", () => {
  test("groups probe latencies into windows by start time", () => {
    const lat = [
      { tMs: 0, ms: 5 },
      { tMs: 10, ms: 1 },
      { tMs: 1000, ms: 9 },
      { tMs: 1500, ms: 3 },
      { tMs: 2500, ms: 2 },
    ];
    const w = windowPercentiles(lat, 1000);
    expect(w.map((x) => [x.startMs, x.count])).toEqual([
      [0, 2],
      [1000, 2],
      [2000, 1],
    ]);
    expect(w[0]).toMatchObject({ p50: 1, p99: 5 });
    expect(w[1]).toMatchObject({ p50: 3, p99: 9 });
  });
  test("empty", () => {
    expect(windowPercentiles([], 1000)).toEqual([]);
  });
});

describe("parseMetrics", () => {
  test("keeps names with labels, skips comments", () => {
    const m = parseMetrics('# HELP a x\n# TYPE a gauge\nomega_rooms 3\nomega_ws_closes_total{code="4004"} 12\nprocess_uptime_seconds 1.5\n');
    expect(m.get("omega_rooms")).toBe(3);
    expect(m.get('omega_ws_closes_total{code="4004"}')).toBe(12);
    expect(m.get("process_uptime_seconds")).toBe(1.5);
    expect(m.size).toBe(3);
  });
});

describe("StderrTally", () => {
  test("counts by level and event, across chunk boundaries", () => {
    const t = new StderrTally();
    t.add('{"level":"error","event":"store.layout","error":"x"}\n{"level":"warn","ev');
    t.add('ent":"gc.sweep"}\nplain text line\n');
    expect(t.counts).toEqual({ "error:store.layout": 1, "warn:gc.sweep": 1, "raw:": 1 });
    expect(t.total).toBe(3);
  });
  test("error events outside the expected list", () => {
    const t = new StderrTally();
    t.add('{"level":"error","event":"ws.encode"}\n{"level":"error","event":"store.layout"}\n{"level":"info","event":"x"}\n');
    expect(t.unexpectedErrors(["ws.encode"])).toEqual({ "store.layout": 1 });
    expect(t.unexpectedErrors([])).toEqual({ "ws.encode": 1, "store.layout": 1 });
  });
});

const good = (): SoakResult => ({
  durationMs: 3 * HOUR,
  segments: [
    [0, 1, 2, 3, 4, 5].map((i) => ({ tMs: i * 1800_000, rss: 50e6, fds: 300, threads: 8, wal: 4096 })),
  ],
  windows: [{ startMs: 0, count: 100, p50: 1, p95: 3, p99: 8 }],
  restarts: [{ exitCode: 0, exitMs: 800, stderr: "", seatsExpected: 5, seatsRestored: 5 }],
  plannedRestarts: 1,
  unplannedExits: 0,
  unexpectedCloses: 0,
  errors: {},
  integrity: "ok",
  consistency: [{ name: "reports", client: 4, server: 4 }],
  abuse: [{ kind: "flood", started: 3, cut: 3 }],
});

describe("evaluate", () => {
  test("a clean run passes every check, and checks are enforced for a long run", () => {
    const checks = evaluate(good());
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    expect(checks.every((c) => c.enforced)).toBe(true);
    const names = checks.map((c) => c.name);
    for (const n of ["no unplanned exits", "no unexpected error lines", "rss slope", "fd slope", "thread slope", "wal slope", "p99 per window", "planned restarts", "integrity_check", "metrics consistency", "abusive clients cut", "unexpected closes"]) expect(names).toContain(n);
  });
  const fails = (r: SoakResult, name: string): boolean => evaluate(r).some((c) => c.name === name && !c.ok);
  test("each criterion fails loudly", () => {
    expect(fails({ ...good(), unplannedExits: 1 }, "no unplanned exits")).toBe(true);
    expect(fails({ ...good(), errors: { "store.layout": 2 } }, "no unexpected error lines")).toBe(true);
    expect(fails({ ...good(), windows: [{ startMs: 0, count: 100, p50: 1, p95: 3, p99: 51 }] }, "p99 per window")).toBe(true);
    expect(fails({ ...good(), integrity: "row 1 missing" }, "integrity_check")).toBe(true);
    expect(fails({ ...good(), unexpectedCloses: 1 }, "unexpected closes")).toBe(true);
    expect(fails({ ...good(), consistency: [{ name: "reports", client: 4, server: 5 }] }, "metrics consistency")).toBe(true);
    expect(fails({ ...good(), abuse: [{ kind: "flood", started: 3, cut: 2 }] }, "abusive clients cut")).toBe(true);
  });
  test("restarts: exit code, time, stderr and seats", () => {
    const r = good();
    const one = (over: Partial<SoakResult["restarts"][number]>): SoakResult => ({ ...r, restarts: [{ exitCode: 0, exitMs: 800, stderr: "", seatsExpected: 5, seatsRestored: 5, ...over }] });
    expect(fails(one({ exitCode: 1 }), "planned restarts")).toBe(true);
    expect(fails(one({ exitCode: null }), "planned restarts")).toBe(true);
    expect(fails(one({ exitMs: 10_001 }), "planned restarts")).toBe(true);
    expect(fails(one({ stderr: "boom" }), "planned restarts")).toBe(true);
    expect(fails(one({ seatsRestored: 4 }), "planned restarts")).toBe(true);
    expect(fails({ ...r, plannedRestarts: 2 }, "planned restarts")).toBe(true);
  });
  test("slopes above the bounds fail", () => {
    const grow = (key: "rss" | "fds" | "threads" | "wal", perHour: number): SoakResult => {
      const r = good();
      return { ...r, segments: [r.segments[0]?.map((s, i) => ({ ...s, [key]: s[key] + (perHour * i) / 2 })) ?? []] };
    };
    expect(fails(grow("rss", BOUNDS.rssBytesPerHour * 2), "rss slope")).toBe(true);
    expect(fails(grow("fds", BOUNDS.fdsPerHour * 2), "fd slope")).toBe(true);
    expect(fails(grow("threads", BOUNDS.threadsPerHour * 2), "thread slope")).toBe(true);
    expect(fails(grow("wal", BOUNDS.walBytesPerHour * 2), "wal slope")).toBe(true);
    expect(fails(grow("rss", BOUNDS.rssBytesPerHour / 2), "rss slope")).toBe(false);
  });
  test("a short run reports the slopes but does not enforce them", () => {
    const r: SoakResult = { ...good(), durationMs: 30 * 60_000 };
    const c = evaluate(r).find((x) => x.name === "rss slope");
    expect(c?.enforced).toBe(false);
    expect(evaluate(r).find((x) => x.name === "p99 per window")?.enforced).toBe(true);
  });
});

describe("parseSoakArgs", () => {
  test("defaults: 24 h, a restart every 3 h", () => {
    const a = parseSoakArgs(["--server", "bun x.ts"]);
    expect(a).toMatchObject({ server: "bun x.ts", minutes: 24 * 60, restartEveryMin: 180, sampleS: 10, rooms: 8, members: 22 });
  });
  test("--minutes shortens the run and the restart spacing follows", () => {
    const a = parseSoakArgs(["--server", "s", "--minutes", "5"]);
    expect(a.minutes).toBe(5);
    expect(a.restartEveryMin).toBeLessThan(5);
  });
  test("rejects more than 500 sockets, a missing server and bad numbers", () => {
    expect(() => parseSoakArgs([])).toThrow();
    expect(() => parseSoakArgs(["--server", "s", "--rooms", "25", "--members", "25"])).toThrow(/500/);
    expect(() => parseSoakArgs(["--server", "s", "--minutes", "0"])).toThrow();
  });
});
