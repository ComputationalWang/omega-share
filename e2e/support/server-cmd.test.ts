import { describe, expect, test } from "bun:test";
import { serverBackend, serverProcess } from "./server-cmd";

// OME-1170: E2E_SERVER=rust runs the whole e2e suite against apps/server-rs; Bun stays the default until the switch.
describe("serverBackend", () => {
  test("defaults to bun, accepts rust, refuses a typo", () => {
    expect(serverBackend({})).toBe("bun");
    expect(serverBackend({ E2E_SERVER: "bun" })).toBe("bun");
    expect(serverBackend({ E2E_SERVER: "rust" })).toBe("rust");
    expect(() => serverBackend({ E2E_SERVER: "rsut" })).toThrow(/E2E_SERVER/);
  });
});

describe("serverProcess", () => {
  test("bun runs the TS entry point", () => {
    expect(serverProcess({})).toEqual({ command: "bun", args: ["apps/server/src/index.ts"] });
  });
  test("rust runs the debug binary from the cargo target dir", () => {
    expect(serverProcess({ E2E_SERVER: "rust", CARGO_TARGET_DIR: "/x/target" })).toEqual({ command: "/x/target/debug/omega-server", args: [] });
  });
});
