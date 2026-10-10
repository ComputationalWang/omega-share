// File-based perf job queue (OME-819). An agent submits a job and ends its run; the runner service works the queue one job at a time
// and writes result.json next to the job; the agent reads it on its next heartbeat. No sleep/poll loops, no flock.
// Layout: <queue>/<id>/job.json, running.json (while running), result.json (when done), run.log, report.md; <queue>/.last-built (sha whose build is reusable).
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface JobRequest {
  readonly sha: string;
  readonly specs: readonly string[];
  readonly requester: string;
  readonly issue: string;
  /** Forces the walk tier for every perf context (ADR 0037); unset = the client picks. */
  readonly motion?: "smooth" | "basic";
}

export interface Job extends JobRequest {
  readonly id: string;
  readonly submittedAt: number;
}

export interface JobResult extends Job {
  readonly status: "passed" | "failed";
  readonly exitCode: number | null;
  readonly reason?: string;
  readonly startedAt: number;
  readonly finishedAt: number;
}

export type JobStatus =
  | { readonly state: "unknown" }
  | { readonly state: "queued"; readonly position: number }
  | { readonly state: "running" }
  | { readonly state: "passed" | "failed" };

export interface RunContext {
  /** The previous job built this sha and passed: skip the build. */
  readonly reuseBuild: boolean;
  readonly signal: AbortSignal;
  readonly logPath: string;
  readonly jobDir: string;
}

export type Executor = (job: Job, ctx: RunContext) => Promise<{ readonly exitCode: number }>;

export const DEFAULT_TIMEOUT_MS = 90 * 60_000;
// A Set of strings, not the union: job.json can be written by hand or by an older client.
const MOTIONS: ReadonlySet<string> = new Set(["smooth", "basic"]);
const SPEC = /^(?:\.\/)?perf\/[\w.-]+\.perf\.ts$/;

function writeJson(path: string, value: unknown): void {
  writeFileSync(`${path}.tmp`, JSON.stringify(value, null, 2));
  renameSync(`${path}.tmp`, path);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function submitJob(dir: string, req: JobRequest, now = Date.now()): string {
  if (!/^[0-9a-f]{40}$/.test(req.sha)) throw new Error(`sha must be a full 40-char commit sha, got ${req.sha}`);
  for (const s of req.specs) if (!SPEC.test(s)) throw new Error(`not a perf spec: ${s} (expected perf/<name>.perf.ts)`);
  if (req.motion !== undefined && !MOTIONS.has(req.motion)) throw new Error(`motion must be smooth or basic, got ${req.motion}`);
  const id = `${String(now).padStart(13, "0")}-${Math.random().toString(36).slice(2, 8)}`;
  mkdirSync(join(dir, id), { recursive: true });
  const job: Job = { ...req, id, submittedAt: now };
  writeJson(join(dir, id, "job.json"), job);
  return id;
}

/** Env for the job's perf run. Always sets OMEGA_PERF_MOTION, so an unforced job can't inherit a tier from the runner's env. */
export function jobEnv(job: Job): Record<string, string> {
  return { OMEGA_PERF_MOTION: job.motion ?? "" };
}

function jobIds(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "job.json"))).map((e) => e.name).sort();
}

export function readResult(dir: string, id: string): JobResult | null {
  return readJson(join(dir, id, "result.json")) as JobResult | null;
}

function isQueued(dir: string, id: string): boolean {
  return !existsSync(join(dir, id, "result.json")) && !existsSync(join(dir, id, "running.json"));
}

export function jobStatus(dir: string, id: string): JobStatus {
  if (!existsSync(join(dir, id, "job.json"))) return { state: "unknown" };
  const result = readResult(dir, id);
  if (result) return { state: result.status };
  if (existsSync(join(dir, id, "running.json"))) return { state: "running" };
  return { state: "queued", position: jobIds(dir).filter((j) => isQueued(dir, j)).indexOf(id) + 1 };
}

/** Fail jobs a dead runner left running, so no agent waits on them forever. */
export function recoverCrashed(dir: string, now = Date.now()): void {
  for (const id of jobIds(dir)) {
    const marker = join(dir, id, "running.json");
    if (!existsSync(marker) || existsSync(join(dir, id, "result.json"))) continue;
    const job = (readJson(join(dir, id, "job.json")) as Job | null);
    if (!job) continue;
    const started = (readJson(marker) as { startedAt: number } | null)?.startedAt ?? now;
    writeJson(join(dir, id, "result.json"), { ...job, status: "failed", exitCode: null, reason: "runner stopped while the job was running", startedAt: started, finishedAt: now } satisfies JobResult);
    rmSync(marker);
    rmSync(join(dir, ".last-built"), { force: true });
  }
}

/** Run every queued job, oldest first, one at a time. Returns how many ran. */
export async function runPending(dir: string, exec: Executor, opts: { timeoutMs?: number } = {}): Promise<number> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let ran = 0;
  for (;;) {
    const id = jobIds(dir).find((j) => isQueued(dir, j));
    const job = id === undefined ? null : (readJson(join(dir, id, "job.json")) as Job | null);
    if (id === undefined) return ran;
    const jobDir = join(dir, id);
    if (!job) {
      writeJson(join(jobDir, "result.json"), { id, status: "failed", exitCode: null, reason: "unreadable job.json", startedAt: Date.now(), finishedAt: Date.now() });
      continue;
    }
    const startedAt = Date.now();
    writeJson(join(jobDir, "running.json"), { startedAt });
    const lastBuilt = join(dir, ".last-built");
    const reuseBuild = existsSync(lastBuilt) && readFileSync(lastBuilt, "utf8") === job.sha;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let outcome: { exitCode: number | null; reason?: string };
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { abort.abort(); reject(new Error(`timed out after ${String(Math.round(timeoutMs / 1000))} s`)); }, timeoutMs);
      });
      const r = await Promise.race([exec(job, { reuseBuild, signal: abort.signal, logPath: join(jobDir, "run.log"), jobDir }), timeout]);
      outcome = { exitCode: r.exitCode };
    } catch (e) {
      outcome = { exitCode: null, reason: e instanceof Error ? e.message : String(e) };
    } finally {
      clearTimeout(timer);
    }
    const passed = outcome.exitCode === 0;
    if (passed) writeFileSync(lastBuilt, job.sha);
    else rmSync(lastBuilt, { force: true });
    const result: JobResult = { ...job, status: passed ? "passed" : "failed", exitCode: outcome.exitCode, ...(outcome.reason === undefined ? {} : { reason: outcome.reason }), startedAt, finishedAt: Date.now() };
    writeJson(join(jobDir, "result.json"), result);
    rmSync(join(jobDir, "running.json"), { force: true });
    ran++;
  }
}

/** The queue lives outside any checkout so every worktree (and the runner service) sees the same one. */
export function queueDir(env: Record<string, string | undefined> = process.env): string {
  const home = env["HOME"] ?? "";
  return env["OMEGA_PERF_QUEUE_DIR"] ?? join(env["XDG_STATE_HOME"] ?? join(home, ".local/state"), "omega-share/perf-queue");
}
