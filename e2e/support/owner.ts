// Owner files (OME-821): every server the e2e harness starts goes through e2e/support/serve.ts, which records who
// started it in <OWNER_DIR>/<port>.json. A run reuses a server only if that file names this agent at HEAD;
// anything else on the port is an error that names its owner. `bun run e2e:reap` reads the same files.
import { spawnSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as v from "valibot";
import { agentName } from "./ports";

/**
 * Shared by every agent on the machine, so it can't be os.tmpdir(): Paperclip gives each run a TMPDIR of its own.
 * $XDG_RUNTIME_DIR is per user and cleared at boot, like the servers it describes.
 */
export function ownerDir(env: Readonly<Record<string, string | undefined>> = process.env, uid: number = process.getuid?.() ?? 0): string {
  const forced = env["OMEGA_OWNER_DIR"];
  if (forced !== undefined && forced !== "") return forced;
  const runtime = env["XDG_RUNTIME_DIR"];
  if (runtime !== undefined && runtime !== "") return join(runtime, "omega-e2e-owners");
  return `/tmp/omega-e2e-owners-${String(uid)}`;
}

export const OWNER_DIR = ownerDir();

const OwnerSchema = v.strictObject({
  port: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65535)),
  /** The launcher (serve.ts). */
  pid: v.pipe(v.number(), v.integer(), v.minValue(1)),
  /** The server's process group, led by the launcher's child. */
  pgid: v.pipe(v.number(), v.integer(), v.minValue(1)),
  agent: v.pipe(v.string(), v.minLength(1)),
  sha: v.string(),
  cmd: v.string(),
  startedAt: v.string(),
  /** The Playwright runner/worker whose exit stops this server; 0 = started standalone, kept until `e2e:reap`. */
  watch: v.pipe(v.number(), v.integer(), v.minValue(0)),
});
export type Owner = v.InferOutput<typeof OwnerSchema>;

const file = (port: number, dir: string): string => join(dir, `${String(port)}.json`);

export function writeOwner(owner: Owner, dir: string = OWNER_DIR): void {
  mkdirSync(dir, { recursive: true });
  const tmp = `${file(owner.port, dir)}.${String(process.pid)}.tmp`;
  writeFileSync(tmp, JSON.stringify(owner));
  renameSync(tmp, file(owner.port, dir));
}

/**
 * Takes the port for `owner` unless another owner file already holds it (atomic: link fails on an existing file),
 * so two launchers racing for one port can't both believe they own it. Written before the server is spawned.
 */
export function claimOwner(owner: Owner, dir: string = OWNER_DIR): boolean {
  mkdirSync(dir, { recursive: true });
  const tmp = `${file(owner.port, dir)}.${String(process.pid)}.claim`;
  writeFileSync(tmp, JSON.stringify(owner));
  try {
    linkSync(tmp, file(owner.port, dir));
    return true;
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "EEXIST") return false;
    throw e;
  } finally {
    rmSync(tmp, { force: true });
  }
}

function parse(path: string): Owner | null {
  try {
    const r = v.safeParse(OwnerSchema, JSON.parse(readFileSync(path, "utf8")));
    return r.success ? r.output : null;
  } catch {
    return null;
  }
}

export function readOwner(port: number, dir: string = OWNER_DIR): Owner | null {
  const o = parse(file(port, dir));
  return o?.port === port ? o : null;
}

export function listOwners(dir: string = OWNER_DIR): Owner[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((n) => /^\d+\.json$/.test(n)).flatMap((n) => parse(join(dir, n)) ?? []);
}

/** Drops the file only while it still belongs to launcher `pid` (or unconditionally without one). */
export function removeOwner(port: number, dir: string = OWNER_DIR, pid?: number): void {
  if (pid !== undefined && readOwner(port, dir)?.pid !== pid) return;
  rmSync(file(port, dir), { force: true });
}

const HAS_PROC = existsSync("/proc/self/cmdline");

/** A process's argv joined by spaces, or null if it's gone. */
function cmdline(pid: number): string | null {
  try {
    return readFileSync(`/proc/${String(pid)}/cmdline`, "utf8").replaceAll("\0", " ").trim();
  } catch {
    return null;
  }
}

function exists(target: number): boolean {
  try {
    process.kill(target, 0);
    return true;
  } catch (e) {
    return e instanceof Error && "code" in e && e.code === "EPERM";
  }
}

/**
 * The owner file's launcher is still running: that pid is alive and is still serve.ts for that port, not a recycled pid.
 * (Without /proc, liveness alone.)
 */
export function launcherAlive(o: Pick<Owner, "pid" | "port">): boolean {
  if (!HAS_PROC) return exists(o.pid);
  const cl = cmdline(o.pid);
  return cl !== null && cl.includes("serve.ts") && cl.includes(`--port ${String(o.port)} `);
}

/** The server's process group still exists, and its leader (if still there) runs the recorded command. */
export function groupAlive(o: Pick<Owner, "pgid" | "cmd">): boolean {
  if (!exists(-o.pgid)) return false;
  if (!HAS_PROC) return true;
  const leader = cmdline(o.pgid);
  return leader === null || leader.includes(o.cmd);
}

/** True while the launcher or the server's group is still ours and running; a recycled pid never counts. */
export function ownerAlive(o: Pick<Owner, "pid" | "pgid" | "port" | "cmd">): boolean {
  return launcherAlive(o) || groupAlive(o);
}

export function describeOwner(o: Owner): string {
  const name = agentName(o.agent);
  const who = name === o.agent ? o.agent : `${name} (${o.agent})`;
  return `${who}, pid ${String(o.pid)}, sha ${o.sha.slice(0, 10)}, started ${o.startedAt}: ${o.cmd}`;
}

export type ReuseDecision = { kind: "start"; stale: boolean } | { kind: "reuse" } | { kind: "refuse"; reason: string };

export function decideReuse(input: { inUse: boolean; owner: Owner | null; alive: (o: Owner) => boolean; agent: string; sha: string }): ReuseDecision {
  const { inUse, owner, agent, sha } = input;
  if (owner === null) {
    if (inUse) return { kind: "refuse", reason: "is in use by a process with no owner file (not started by the e2e harness). Find it with `ss -ltnp`; stop it only if it's yours." };
    return { kind: "start", stale: false };
  }
  if (!input.alive(owner)) {
    if (!inUse) return { kind: "start", stale: true };
    if (owner.agent === agent) return { kind: "refuse", reason: `is held by an orphan of yours whose launcher is gone (${describeOwner(owner)}). Run \`bun run e2e:reap\`.` };
    return { kind: "refuse", reason: `is held by a leftover whose launcher is gone (${describeOwner(owner)}). Not yours to stop: its owner runs \`bun run e2e:reap\`.` };
  }
  if (owner.agent !== agent) return { kind: "refuse", reason: `belongs to another agent: ${describeOwner(owner)}. It is not yours to reuse or stop; your own block is free of it unless OMEGA_*_PORT points here.` };
  if (owner.sha !== sha) return { kind: "refuse", reason: `is your own server from another commit (${describeOwner(owner)}; HEAD is ${sha.slice(0, 10)}). Run \`bun run e2e:reap\`.` };
  if (owner.watch !== 0) return { kind: "refuse", reason: `is in use by another run of yours (runner pid ${String(owner.watch)} stops it when it ends: ${describeOwner(owner)}). Wait for that run, or give this one another slot with OMEGA_PORT_SLOT.` };
  if (!inUse) return { kind: "refuse", reason: `has a live owner that isn't listening yet (${describeOwner(owner)}). Wait for it, or run \`bun run e2e:reap\`.` };
  return { kind: "reuse" };
}

/** The commit a server is started from; dev servers run the working tree, so HEAD is the build. */
export function headSha(cwd: string = join(import.meta.dirname, "../..")): string {
  const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "unknown";
}

export function reapTargets(owners: readonly Owner[], agent: string): Owner[] {
  return owners.filter((o) => o.agent === agent);
}
