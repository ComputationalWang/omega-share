import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

  test("refuses PORT=0 (ngrok can't point at it)", () => {
    const r = Bun.spawnSync(["bash", SCRIPT, URL, "--dry-run"], { env: { PATH: process.env["PATH"] ?? "", PORT: "0" }, stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(2);
  });

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

  // Stand-ins for bun, curl and ngrok that record what they were started with instead of doing it.
  const withFakes = (fn: (dir: string, run: (...args: string[]) => number) => void) => {
    const dir = mkdtempSync(join(tmpdir(), "omega-tunnel-"));
    const fake = (name: string, body: string) => {
      writeFileSync(join(dir, name), `#!/usr/bin/env bash\n${body}\n`);
      chmodSync(join(dir, name), 0o755);
    };
    fake("bun", `[[ "$1" == run ]] && { touch "${dir}/built"; exit 0; }\necho "\${NGROK_AUTHTOKEN-unset}" > "${dir}/server.env"\nexec sleep 5`);
    fake("curl", "exit 0");
    fake("ngrok", `echo "\${NGROK_AUTHTOKEN-unset}" > "${dir}/ngrok.env"`);
    const runWithFakes = (...args: string[]) =>
      Bun.spawnSync(["bash", SCRIPT, ...args], {
        env: { PATH: `${dir}:${process.env["PATH"] ?? ""}`, HOME: process.env["HOME"] ?? "", NGROK_AUTHTOKEN: CANARY, PORT: "18787" },
        stdout: "pipe",
        stderr: "pipe",
      }).exitCode;
    try {
      fn(dir, runWithFakes);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test.each([["--dryrun"], ["-n"], ["--dry-run", "extra"]])("an unknown or extra flag %p exits 2 and starts nothing", (...flags: string[]) => {
    withFakes((dir, runWithFakes) => {
      expect(runWithFakes(URL, ...flags)).toBe(2);
      expect(existsSync(join(dir, "built"))).toBe(false);
      expect(existsSync(join(dir, "server.env"))).toBe(false);
      expect(existsSync(join(dir, "ngrok.env"))).toBe(false);
    });
  });

  test("the server never holds NGROK_AUTHTOKEN; ngrok still gets it (T-14)", () => {
    withFakes((dir, runWithFakes) => {
      expect(runWithFakes(URL)).toBe(0);
      expect(readFileSync(join(dir, "server.env"), "utf8").trim()).toBe("unset");
      expect(readFileSync(join(dir, "ngrok.env"), "utf8").trim()).toBe(CANARY);
    });
  });
});
