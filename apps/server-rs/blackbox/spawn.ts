/** Spawns the binary for one test and reaps it, whatever happens to the harness. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Spawned {
  port: number;
  /** The first stdout line. */
  banner: string;
  stop: () => Promise<void>;
}

const BOOT_TIMEOUT_MS = 10_000;
/** `stop()` doesn't wait out the server's drain grace: a test is over. */
const STOP_DEADLINE_MS = 2_000;
const LISTENING = /omega-share server on http:\/\/([^/\s]+)\//;

interface Live {
  child: Bun.Subprocess;
  dir: string;
}
const live = new Set<Live>();
let reaper = false;

function reap(entry: Live): void {
  entry.child.kill("SIGKILL");
  rmSync(entry.dir, { recursive: true, force: true });
  live.delete(entry);
}

/**
 * Whether the child is gone. `exitCode` only moves when the event loop runs, which this synchronous
 * poll never lets it, so ask the OS (a dead child nobody has reaped yet is a zombie, state `Z`).
 */
function exited(child: Bun.Subprocess): boolean {
  const state = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(child.pid)])
    .stdout.toString()
    .trim();
  return state === "" || state.startsWith("Z");
}

/** Kills every child still running and removes its temp dir (also runs on exit and on signals). */
export function killAll(): void {
  for (const entry of [...live]) reap(entry);
}

function installReaper(): void {
  if (reaper) return;
  reaper = true;
  process.on("exit", killAll);
  // 128 + signal number, as a shell reports it.
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const) {
    process.on(signal, () => {
      killAll();
      process.exit(code);
    });
  }
}

/**
 * Spawns `bin` synchronously, like the in-process start: the environment is exactly `env` (plus the
 * stdin guard), stdout goes to a temp file polled for the listening line. The child's stdin is a pipe
 * the test-hooks binary reads: when this process dies the pipe closes and the child exits.
 */
export function spawnServer(bin: string, env: Record<string, string>): Spawned {
  installReaper();
  const dir = mkdtempSync(join(tmpdir(), "omega-bb-"));
  const out = join(dir, "stdout");
  const err = join(dir, "stderr");
  let child: Bun.Subprocess;
  try {
    child = Bun.spawn([bin], {
      env: { PATH: process.env["PATH"] ?? "", ...env, OMEGA_TEST_STDIN_GUARD: "1" },
      stdin: "pipe",
      stdout: Bun.file(out),
      stderr: Bun.file(err),
    });
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  const entry: Live = { child, dir };
  live.add(entry);
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  for (;;) {
    const banner = readFileSync(out, "utf8").split("\n")[0] ?? "";
    const host = LISTENING.exec(banner)?.[1];
    if (host !== undefined) {
      const port = Number(host.slice(host.lastIndexOf(":") + 1));
      const stop = async (): Promise<void> => {
        child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), STOP_DEADLINE_MS);
        await child.exited;
        clearTimeout(timer);
        reap(entry);
      };
      return { port, banner, stop };
    }
    if (exited(child) || Date.now() > deadline) {
      const why = readFileSync(err, "utf8").trim();
      reap(entry);
      throw new Error(`omega-server did not start: ${why}`);
    }
    Bun.sleepSync(20);
  }
}
