import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "../../../scripts/tunnel.sh");
const CANARY = "canary-authtoken-9f8e7d";
const URL = "https://quiet-otter.ngrok-free.app";

const run = (...args: string[]) => {
  const r = Bun.spawnSync(["bash", SCRIPT, ...args], {
    env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", NGROK_AUTHTOKEN: CANARY },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
};

describe("scripts/tunnel.sh (ADR 0015 §2)", () => {
  test.each([[], ["http://quiet-otter.ngrok-free.app"], [`${URL}/r/lobby`], ["quiet-otter.ngrok-free.app"], [`${URL}?x`]])(
    "refuses %p with usage and exit 2",
    (...args: string[]) => {
      const r = run(...args, "--dry-run");
      expect(r.code).toBe(2);
      expect(r.out).toContain("usage");
      expect(r.out).not.toContain("ngrok http");
    },
  );

  test("a dry run shows the loopback-only server and tunnel it would start", () => {
    const r = run(URL, "--dry-run");
    expect(r.code).toBe(0);
    expect(r.out).toContain(`PUBLIC_ORIGIN=${URL}`);
    expect(r.out).toContain("TRUST_PROXY=loopback");
    expect(r.out).toContain("HOST=127.0.0.1");
    expect(r.out).toContain("STATIC_DIR=");
    expect(r.out).toContain(`ngrok http 127.0.0.1:8787 --url ${URL}`);
  });

  test("never prints the authtoken or puts it on a command line (T-14)", () => {
    const r = run(URL, "--dry-run");
    expect(r.out).not.toContain(CANARY);
    const script = readFileSync(SCRIPT, "utf8");
    expect(script).not.toContain("--authtoken");
    expect(script).not.toMatch(/set -[a-z]*x|printenv|^\s*env\s*$/m);
    expect(script).not.toContain("add-authtoken");
  });
});
