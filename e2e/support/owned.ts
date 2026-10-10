// Servers a spec starts itself (OME-821) go through the launcher too: they get an owner file, refuse a port held by
// someone else, and die with the worker that started them. Stop them with signalOwned, which reaches the server's own
// process group (a bare SIGKILL to the launcher alone would leave the server running).
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { join } from "node:path";
import { OWNER_DIR, readOwner, removeOwner } from "./owner";

const LAUNCHER = join(import.meta.dirname, "serve.ts");

/** The launcher command line for `argv` on `port`, watching `watch` (by default this process). */
export function ownedCommand(port: number, argv: readonly string[], watch: number = process.pid): string[] {
  return ["bun", LAUNCHER, "--port", String(port), "--watch", String(watch), "--", ...argv];
}

/** Like spawn(command, args, options), through the launcher. Always its own process group. */
export function spawnOwned(port: number, command: string, args: readonly string[], options: SpawnOptions): ChildProcess {
  const [bun = "bun", ...rest] = ownedCommand(port, [command, ...args]);
  return spawn(bun, rest, { ...options, detached: true });
}

/** Signals the server's process group and the launcher's. After SIGKILL the owner file goes too. */
export function signalOwned(child: ChildProcess, port: number, signal: NodeJS.Signals): void {
  const owner = readOwner(port);
  const targets = [child.pid === undefined ? undefined : -child.pid, owner !== null && owner.pid === child.pid ? -owner.pgid : undefined];
  for (const target of targets) {
    if (target === undefined) continue;
    try {
      process.kill(target, signal);
    } catch {
      // already gone
    }
  }
  if (signal === "SIGKILL" && child.pid !== undefined) removeOwner(port, OWNER_DIR, child.pid);
}
