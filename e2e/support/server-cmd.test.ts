import { describe, expect, test } from "bun:test";
import { buildRustServer, serverBackend, serverProcess } from "./server-cmd";

// OME-1170: E2E_SERVER=rust runs the whole e2e suite against apps/server-rs; Rust is the default (production runs it); E2E_SERVER=bun keeps the TS reference until S13.
describe("serverBackend", () => {
  test("defaults to rust, accepts bun, refuses a typo", () => {
    expect(serverBackend({})).toBe("rust");
    expect(serverBackend({ E2E_SERVER: "bun" })).toBe("bun");
    expect(serverBackend({ E2E_SERVER: "rust" })).toBe("rust");
    expect(() => serverBackend({ E2E_SERVER: "rsut" })).toThrow(/E2E_SERVER/);
  });
});

describe("serverProcess", () => {
  test("bun runs the TS entry point", () => {
    expect(serverProcess({ E2E_SERVER: "bun" })).toEqual({ command: "bun", args: ["apps/server/src/index.ts"] });
  });
  test("rust runs the e2e-profile binary (an optimised build, so the server does not starve the browser) from the cargo target dir", () => {
    expect(serverProcess({ CARGO_TARGET_DIR: "/x/target" })).toEqual({ command: "/x/target/e2e/omega-server", args: [] });
  });
});

// OME-1210: a cargo that cannot spawn (not on PATH) has status null; the error must name the spawn failure, not just "failed".
describe("buildRustServer", () => {
  test("names the spawn error and the PATH when cargo is not found", () => {
    expect(() => buildRustServer({ PATH: "/nonexistent" })).toThrow(/ENOENT[\s\S]*PATH/);
  });
});
