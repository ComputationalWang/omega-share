import { describe, expect, test } from "bun:test";
import { categorize, type Evidence } from "./classify";

const e = (over: Partial<Evidence>): Evidence => ({
  status: "fail",
  serverFree: false,
  reason: "",
  source: "",
  notServer: false,
  ...over,
});

describe("categorize", () => {
  test("a test that talks to a server and needs no injection is A", () => {
    expect(categorize(e({}))).toBe("A");
    expect(categorize(e({ status: "pass" }))).toBe("A");
  });

  test("shell-script tests are E, whatever they do", () => {
    expect(categorize(e({ notServer: true, status: "pass", serverFree: true }))).toBe("E");
  });

  test("a test that passes without a server is a white-box unit: D", () => {
    expect(categorize(e({ status: "pass", serverFree: true }))).toBe("D");
  });

  test("clocks, schedulers and shortened intervals are B", () => {
    for (const option of ["now", "wallNow", "schedule", "statusIntervalMs", "joinTimeoutMs", "roomGcIntervalMs"]) {
      expect(
        categorize(e({ status: "not-black-box", reason: `${option}: not expressible as an environment variable` })),
      ).toBe("B");
    }
  });

  test("a store or seat holds with a real database is C; with spies it is D", () => {
    const reason = "store: not expressible as an environment variable";
    expect(categorize(e({ status: "not-black-box", reason, source: "db = openDatabase(':memory:')" }))).toBe("C");
    expect(categorize(e({ status: "not-black-box", reason, source: "const calls = []; calls.push(x)" }))).toBe("D");
    expect(categorize(e({ status: "not-black-box", reason: "seatHolds: not expressible", source: "" }))).toBe("D");
  });

  test("registry, rooms, ownHosts and server internals are D", () => {
    for (const reason of [
      "registry: x",
      "rooms: x",
      "ownHosts: x",
      "server.publish is not available",
      "server.reports is not available",
    ]) {
      expect(categorize(e({ status: "not-black-box", reason }))).toBe("D");
    }
  });

  test("limits with no environment variable yet, metrics text and drain are A*: as-is once the slice adds the knob", () => {
    for (const reason of [
      "maxConnectionsPerIp: x",
      "maxHttpInFlight: x",
      "server.metricsText is not available",
      "server.drain is not available",
    ]) {
      expect(categorize(e({ status: "not-black-box", reason }))).toBe("A*");
    }
  });

  test("a failure that mentions a fake clock or a database file is B or C", () => {
    expect(categorize(e({ source: "const clock = new TestClock()" }))).toBe("B");
    expect(categorize(e({ source: "const path = join(dir, 'omega.db'); openDatabase(path)" }))).toBe("C");
  });

  test("skipped stays skipped", () => {
    expect(categorize(e({ status: "skip" }))).toBe("skipped");
  });
});
