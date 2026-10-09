import { describe, expect, test } from "bun:test";
import {
  cpuPercent,
  findPersonalData,
  histogramQuantile,
  parseProcStat,
  parsePrometheus,
  percentile,
  relayHistogram,
  simulatedAddress,
} from "./hosted-load-lib";

const SCRAPE = (counts: number[], sum: number, rss: number): string => {
  const les = ["5e-05", "0.0001", "0.00025", "0.0005", "0.001", "0.0025", "0.005", "0.01", "0.025", "0.05", "+Inf"];
  let c = 0;
  const lines = les.map((le, i) => {
    c += counts[i] ?? 0;
    return `omega_relay_latency_seconds_bucket{le="${le}"} ${String(c)}`;
  });
  return [
    "# HELP omega_rooms Live rooms.",
    "# TYPE omega_rooms gauge",
    "omega_rooms 22",
    "omega_members 500",
    ...lines,
    `omega_relay_latency_seconds_sum ${String(sum)}`,
    `omega_relay_latency_seconds_count ${String(c)}`,
    'omega_ws_closes_total{code="1012"} 3',
    `process_resident_memory_bytes ${String(rss)}`,
    "",
  ].join("\n");
};

describe("parsePrometheus", () => {
  test("reads series with and without labels, skips comments and blanks", () => {
    const m = parsePrometheus(SCRAPE([1, 2], 0.5, 1e8));
    expect(m.get("omega_rooms")).toBe(22);
    expect(m.get('omega_ws_closes_total{code="1012"}')).toBe(3);
    expect(m.get("process_resident_memory_bytes")).toBe(1e8);
    expect(m.get('omega_relay_latency_seconds_bucket{le="0.0001"}')).toBe(3);
    expect([...m.keys()].some((k) => k.startsWith("#"))).toBe(false);
  });

  test("ignores lines that aren't a series and a number", () => {
    const m = parsePrometheus("garbage\nfoo bar\nok 1\n");
    expect([...m.entries()]).toEqual([["ok", 1]]);
  });
});

describe("relayHistogram + histogramQuantile", () => {
  test("p95 over a window interpolates inside the bucket that holds it", () => {
    const before = relayHistogram(parsePrometheus(SCRAPE([10], 0, 0)));
    // Window: 100 new observations, 90 in (0.0005, 0.001], 10 in (0.001, 0.0025].
    const after = relayHistogram(parsePrometheus(SCRAPE([10, 0, 0, 0, 90, 10], 0, 0)));
    expect(after.count - before.count).toBe(100);
    // Rank 95 → 5 of the 10 in (0.001, 0.0025]: 0.001 + 0.5 × 0.0015.
    expect(histogramQuantile(before, after, 0.95)).toBeCloseTo(0.00175, 8);
    expect(histogramQuantile(before, after, 0.5)).toBeCloseTo(0.0005 + (50 / 90) * 0.0005, 8);
  });

  test("a quantile in +Inf reports Infinity (over the top bucket, 50 ms)", () => {
    const before = relayHistogram(parsePrometheus(SCRAPE([], 0, 0)));
    const after = relayHistogram(parsePrometheus(SCRAPE([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 99], 0, 0)));
    expect(histogramQuantile(before, after, 0.95)).toBe(Infinity);
  });

  test("an empty window is null, not 0", () => {
    const h = relayHistogram(parsePrometheus(SCRAPE([5], 0, 0)));
    expect(histogramQuantile(h, h, 0.95)).toBeNull();
  });

  test("a counter reset (restart) between scrapes is treated as a fresh start", () => {
    const before = relayHistogram(parsePrometheus(SCRAPE([1000], 0, 0)));
    const after = relayHistogram(parsePrometheus(SCRAPE([0, 0, 0, 0, 10], 0, 0)));
    expect(histogramQuantile(before, after, 0.5)).toBeCloseTo(0.00075, 8);
  });
});

describe("parseProcStat + cpuPercent", () => {
  test("parses after the last ')' so a comm with spaces and parens can't shift fields", () => {
    const fields = Array.from({ length: 50 }, (_, i) => String(i));
    // Fields after comm start at field 3 (state). utime = field 14, stime = 15, rss (pages) = 24.
    fields[0] = "S"; // field 3
    fields[11] = "700"; // field 14
    fields[12] = "300"; // field 15
    fields[21] = "25600"; // field 24
    const line = `4242 (bun (x) y) ${fields.join(" ")}`;
    expect(parseProcStat(line)).toEqual({ ticks: 1000, rssPages: 25600 });
  });

  test("rejects a line without a comm", () => {
    expect(parseProcStat("nope")).toBeNull();
  });

  test("CPU % of one core from tick and wall deltas", () => {
    expect(cpuPercent({ ticks: 1000, at: 100 }, { ticks: 1350, at: 110 }, 100)).toBeCloseTo(35, 6);
    expect(cpuPercent({ ticks: 0, at: 5 }, { ticks: 0, at: 5 }, 100)).toBeNull();
  });
});

describe("simulatedAddress", () => {
  test("is in the RFC 2544 benchmark range 198.18.0.0/15 and distinct per room and client", () => {
    const seen = new Set<string>();
    for (let r = 0; r < 20; r++) for (let c = 0; c < 25; c++) seen.add(simulatedAddress(r, c));
    expect(seen.size).toBe(500);
    for (const a of seen) expect(a).toMatch(/^198\.1[89]\.\d{1,3}\.\d{1,3}$/);
  });

  test("throws outside the range it can map", () => {
    expect(() => simulatedAddress(512, 0)).toThrow();
    expect(() => simulatedAddress(0, 255)).toThrow();
  });
});

describe("findPersonalData", () => {
  test("reports each needle found, with a count, and nothing for clean text", () => {
    const text = "omega_rooms 3\nroom abc123 joined by L01m02\nabc123 again\n";
    expect(findPersonalData(text, ["abc123", "L01m02", "zzz"])).toEqual([
      { needle: "abc123", count: 2 },
      { needle: "L01m02", count: 1 },
    ]);
    expect(findPersonalData("omega_rooms 3\n", ["abc123"])).toEqual([]);
  });

  test("matches case-insensitively and ignores empty needles", () => {
    expect(findPersonalData("QA2 LOAD 01", ["qa2 load 01", ""])).toEqual([{ needle: "qa2 load 01", count: 1 }]);
  });
});

describe("percentile", () => {
  test("nearest-rank on a copy; null for no data", () => {
    const xs = [5, 1, 4, 2, 3];
    expect(percentile(xs, 0.5)).toBe(3);
    expect(percentile(xs, 0.95)).toBe(5);
    expect(xs).toEqual([5, 1, 4, 2, 3]);
    expect(percentile([], 0.95)).toBeNull();
  });
});
