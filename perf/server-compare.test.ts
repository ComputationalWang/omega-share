import { describe, expect, test } from "bun:test";
import { cpuPercent, loopbackAddrs, parseArgs, parseProcStat, parseProcStatus, percentile, verdictRows } from "./server-compare";

describe("percentile", () => {
  test("nearest rank, like relay-latency", () => {
    const s = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(s, 50)).toBe(5);
    expect(percentile(s, 95)).toBe(10);
    expect(percentile(s, 99)).toBe(10);
    expect(percentile([], 99)).toBe(0);
  });
});

describe("/proc parsing", () => {
  test("status: VmRSS and VmHWM in bytes", () => {
    const text = "Name:\tbun\nVmPeak:\t  900 kB\nVmHWM:\t  2048 kB\nVmRSS:\t  1024 kB\nThreads:\t4\n";
    expect(parseProcStatus(text)).toEqual({ rss: 1024 * 1024, hwm: 2048 * 1024 });
    expect(parseProcStatus("Name:\tx\n")).toBeNull();
  });
  test("stat: utime+stime, comm with spaces and parens", () => {
    const text = "123 (my (odd) srv) S 1 123 123 0 -1 4194560 100 0 0 0 150 50 0 0 20 0 4 0 99 1 2 3";
    expect(parseProcStat(text)).toEqual({ ticks: 200 });
    expect(parseProcStat("garbage")).toBeNull();
  });
  test("cpu percent from tick delta (100 Hz)", () => {
    expect(cpuPercent(0, 150, 1000)).toBe(150);
    expect(cpuPercent(0, 10, 0)).toBe(0);
  });
});

describe("loopbackAddrs", () => {
  test("keeps every address under the per-IP cap", () => {
    expect(loopbackAddrs(500).length).toBeGreaterThanOrEqual(13);
    expect(loopbackAddrs(10, 50)).toEqual(["127.0.0.1"]);
    expect(loopbackAddrs(500, 50).every((a) => /^127\.0\.0\.\d+$/.test(a))).toBe(true);
  });
});

describe("args", () => {
  test("defaults and flags", () => {
    const a = parseArgs(["--server", "bun x.ts"]);
    expect(a).toMatchObject({ mode: "run", server: "bun x.ts", rooms: 20, members: 25, noise: 5 });
    const b = parseArgs(["--server", "s", "--rooms", "3", "--members", "4", "--duration", "10", "--probes", "7", "--label", "rs"]);
    expect(b).toMatchObject({ rooms: 3, members: 4, duration: 10, probes: 7, label: "rs" });
  });
  test("--batch 1 opts every member in; off by default", () => {
    expect(parseArgs(["--server", "s"])).toMatchObject({ batch: false });
    expect(parseArgs(["--server", "s", "--batch", "1"])).toMatchObject({ batch: true });
    expect(parseArgs(["--server", "s", "--batch", "0"])).toMatchObject({ batch: false });
    expect(() => parseArgs(["--server", "s", "--batch", "yes"])).toThrow();
  });
  test("compare takes two files and a noise", () => {
    expect(parseArgs(["--compare", "a.json", "b.json", "--noise", "10"])).toEqual({ mode: "compare", a: "a.json", b: "b.json", noise: 10 });
  });
  test("rejects bad input", () => {
    expect(() => parseArgs([])).toThrow();
    expect(() => parseArgs(["--server", "s", "--rooms", "0"])).toThrow();
    expect(() => parseArgs(["--server", "s", "--members", "26"])).toThrow();
    expect(() => parseArgs(["--compare", "a.json"])).toThrow();
  });
});

describe("verdicts", () => {
  const base = { p99: 10, rssPeak: 100, cpuAvg: 0 };
  test("lower is better, within noise is same", () => {
    const rows = verdictRows({ ...base, p99: 10 }, { ...base, p99: 8, rssPeak: 103 }, 5);
    expect(rows.find((r) => r.metric === "p99")).toMatchObject({ delta: -20, verdict: "better" });
    expect(rows.find((r) => r.metric === "rssPeak")?.verdict).toBe("same within noise");
    expect(verdictRows({ p99: 10 }, { p99: 12 }, 5)[0]?.verdict).toBe("worse");
  });
  test("zero baselines", () => {
    expect(verdictRows({ cpuAvg: 0 }, { cpuAvg: 0 }, 5)[0]?.verdict).toBe("same within noise");
    expect(verdictRows({ cpuAvg: 0 }, { cpuAvg: 1 }, 5)[0]?.verdict).toBe("worse");
  });
});
