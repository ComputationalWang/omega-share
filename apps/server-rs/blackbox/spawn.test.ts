import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killAll, spawnServer } from "./spawn";

let scratch = "";
let oldTmp: string | undefined;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "omega-spawn-test-"));
  oldTmp = process.env["TMPDIR"];
  // spawnServer's own temp dirs land here, so the test can see what is left behind.
  process.env["TMPDIR"] = scratch;
});
afterEach(() => {
  killAll();
  if (oldTmp === undefined) delete process.env["TMPDIR"];
  else process.env["TMPDIR"] = oldTmp;
  rmSync(scratch, { recursive: true, force: true });
});

const leftovers = (): string[] => readdirSync(scratch).filter((f) => f.startsWith("omega-bb-"));

/** A fake server: a shell script that prints the listening line, then runs `body`. */
function fake(body: string): string {
  const path = join(scratch, `fake-${String(Math.random()).slice(2)}.sh`);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}
const LINE = `echo "omega-share server on http://127.0.0.1:4242/ (site origin x) guard=$OMEGA_TEST_STDIN_GUARD"`;
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("spawnServer", () => {
  test("reads the port from the listening line and passes the environment, with the stdin guard on", () => {
    const s = spawnServer(fake(`${LINE}\nexec sleep 30`), { FOO: "1" });
    expect(s.port).toBe(4242);
    expect(s.banner).toContain("guard=1");
  });

  test("stop sends SIGTERM and waits for a server that exits", async () => {
    const s = spawnServer(fake(`${LINE}\nexec sleep 30`), {});
    await s.stop();
    expect(leftovers()).toEqual([]);
  });

  test("stop does not wait out a server that ignores SIGTERM: SIGKILL after about 2 s", async () => {
    const s = spawnServer(fake(`trap '' TERM\n${LINE}\nwhile :; do sleep 0.1; done`), {});
    const started = Date.now();
    await s.stop();
    const took = Date.now() - started;
    expect(took).toBeGreaterThan(1500);
    expect(took).toBeLessThan(4000);
    expect(leftovers()).toEqual([]);
  });

  test("a server that dies at startup throws its stderr and leaves no temp dir", () => {
    const bin = fake(`echo "invalid PORT: nope" >&2\nexit 1`);
    expect(() => spawnServer(bin, {})).toThrow("invalid PORT: nope");
    expect(leftovers()).toEqual([]);
  });

  test("a missing binary throws and leaves no temp dir", () => {
    expect(() => spawnServer(join(scratch, "nope"), {})).toThrow();
    expect(leftovers()).toEqual([]);
  });

  test("killAll kills every child and removes their temp dirs", () => {
    const a = spawnServer(fake(`${LINE}\nexec sleep 30`), {});
    const b = spawnServer(fake(`${LINE}\nexec sleep 30`), {});
    expect(leftovers()).toHaveLength(2);
    killAll();
    expect(leftovers()).toEqual([]);
    expect(existsSync(scratch)).toBe(true);
    expect([a, b].every((s) => typeof s.port === "number")).toBe(true);
  });

  test("closing the stdin pipe (the harness dying) is what the guard listens to: the child is given a pipe", async () => {
    const pidFile = join(scratch, "pid");
    const s = spawnServer(
      fake(
        `${LINE}\necho $$ > ${pidFile}\n{ [ -p /dev/stdin ] || [ -S /dev/stdin ]; } && echo pipe > ${pidFile}.stdin\nexec sleep 30`,
      ),
      {},
    );
    await Bun.sleep(100);
    expect(existsSync(`${pidFile}.stdin`)).toBe(true);
    const pid = Number(await Bun.file(pidFile).text());
    expect(alive(pid)).toBe(true);
    await s.stop();
    expect(alive(pid)).toBe(false);
  });
});
