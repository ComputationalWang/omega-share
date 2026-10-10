// Owner files (OME-821): every server the e2e harness starts goes through e2e/support/serve.ts, which records who
// started it in <OWNER_DIR>/<port>.json. A run reuses a server only if that file names this agent at HEAD;
// anything else on the port is an error that names its owner. `bun run e2e:reap` reads the same files.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
});
export type Owner = v.InferOutput<typeof OwnerSchema>;

const file = (port: number, dir: string): string => join(dir, `${String(port)}.json`);

export function writeOwner(owner: Owner, dir: string = OWNER_DIR): void {
  mkdirSync(dir, { recursive: true });
  const tmp = `${file(owner.port, dir)}.${String(process.pid)}.tmp`;
  writeFileSync(tmp, JSON.stringify(owner));
  renameSync(tmp, file(owner.port, dir));
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

/** True while the launcher or anything in the server's group is still running. */
export function ownerAlive(o: Pick<Owner, "pid" | "pgid">): boolean {
  for (const target of [o.pid, -o.pgid]) {
    try {
      process.kill(target, 0);
      return true;
    } catch (e) {
      if (e instanceof Error && "code" in e && e.code === "EPERM") return true;
    }
  }
  return false;
}

export function describeOwner(o: Owner): string {
  const name = agentName(o.agent);
  const who = name === o.agent ? o.agent : `${name} (${o.agent})`;
  return `${who}, pid ${String(o.pid)}, sha ${o.sha.slice(0, 10)}, started ${o.startedAt}: ${o.cmd}`;
}

export type ReuseDecision = { kind: "start"; stale: boolean } | { kind: "reuse" } | { kind: "refuse"; reason: string };

export function decideReuse(input: { inUse: boolean; owner: Owner | null; alive: (o: Owner) => boolean; agent: string; sha: string }): ReuseDecision {
  const { inUse, owner, agent, sha } = input;
  const live = owner !== null && input.alive(owner);
  if (owner === null || !live) {
    if (inUse) return { kind: "refuse", reason: "is in use by a process with no owner file (not started by the e2e harness, or its launcher died). Find it with `ss -ltnp` and stop it." };
    return { kind: "start", stale: owner !== null };
  }
  if (owner.agent !== agent) return { kind: "refuse", reason: `belongs to another agent: ${describeOwner(owner)}. It is not yours to reuse or stop; your own block is free of it unless OMEGA_*_PORT points here.` };
  if (owner.sha !== sha) return { kind: "refuse", reason: `is your own server from another commit (${describeOwner(owner)}; HEAD is ${sha.slice(0, 10)}). Run \`bun run e2e:reap\`.` };
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
