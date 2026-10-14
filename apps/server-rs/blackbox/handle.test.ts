import { describe, expect, test } from "bun:test";
import { inspect } from "node:util";
import { NotBlackBox } from "./env";
import { blackBoxServer } from "./handle";

const stop = (): Promise<void> => Promise.resolve();

describe("the black-box server handle", () => {
  test("port and stop are real", () => {
    const h = blackBoxServer(4242, stop);
    expect(h.port).toBe(4242);
    expect(h.stop).toBe(stop);
  });

  test("in-process internals throw NotBlackBox naming the member", () => {
    const h = blackBoxServer(1, stop) as unknown as Record<string, unknown>;
    for (const member of ["registry", "drain", "metricsText", "publish", "reports", "pendingWebSockets"]) {
      expect(() => h[member]).toThrow(NotBlackBox);
      expect(() => h[member]).toThrow(member);
    }
  });

  test("await, JSON, inspect, string conversion and expect() don't trip it", async () => {
    const h = blackBoxServer(7, stop);
    expect(await Promise.resolve(h)).toBe(h);
    expect(JSON.stringify(h)).toBe('{"port":7}');
    expect(inspect(h)).toContain("7");
    expect(`${String(h.port)}`).toBe("7");
    expect(() => expect(h).toBe(h)).not.toThrow();
    expect(Reflect.get(h, Symbol.toPrimitive)).toBeUndefined();
    expect(Reflect.get(h, "then")).toBeUndefined();
    expect(Reflect.get(h, "toJSON")).toBeUndefined();
    expect(Reflect.get(h, "somethingElse")).toBeUndefined();
  });
});
