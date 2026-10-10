// The perf runner service (OME-819): works the queue one job at a time in its own worktree. `bun perf/runner/serve.ts`, run by the
// omega-share-perf-runner user unit (docs/ops/perf-runner.md). Env: OMEGA_PERF_REPO (the main checkout; default: this one), OMEGA_PERF_QUEUE_DIR,
// OMEGA_FIXTURE_PORT / OMEGA_WEB_PORT / OMEGA_SERVER_PORT (the runner's own ports, so it never collides with a QA agent's e2e).
import { loadavg, cpus } from "node:os";
import { existsSync, copyFileSync, createWriteStream } from "node:fs";
import { join, resolve } from "node:path";
import { jobEnv, queueDir, recoverCrashed, runPending, type Executor, type LoadGate } from "./queue";

const repo = resolve(process.env["OMEGA_PERF_REPO"] ?? join(import.meta.dir, "../.."));
const dir = queueDir();
// OME-882: start on an idle host, call a run invalid when load spikes. maxLoad is high because the run itself loads the box.
const num = (k: string, d: number): number => { const v = Number(process.env[k]); return process.env[k] !== undefined && Number.isFinite(v) ? v : d; };
const load: LoadGate = {
  read: () => loadavg()[0] ?? 0,
  idleLoad: num("OMEGA_PERF_IDLE_LOAD", 2),
  idleMs: num("OMEGA_PERF_IDLE_SECONDS", 30) * 1000,
  maxWaitMs: num("OMEGA_PERF_MAX_WAIT_MINUTES", 30) * 60_000,
  maxLoad: num("OMEGA_PERF_MAX_LOAD", Math.round(cpus().length * 0.75)),
  sampleMs: 5000,
  maxRequeues: num("OMEGA_PERF_MAX_REQUEUES", 3),
};
const worktree = join(dir, "..", "perf-worktree");

async function sh(cmd: string[], cwd: string, log: ReturnType<typeof createWriteStream>, signal: AbortSignal, env: Record<string, string> = {}): Promise<number> {
  log.write(`$ ${cmd.join(" ")}\n`);
  // setsid: the child leads its own process group, so a timeout can kill Playwright and its browsers with it.
  const p = Bun.spawn(["setsid", ...cmd], { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const pump = async (s: ReadableStream<Uint8Array>): Promise<void> => { for await (const c of s) log.write(c); };
  const kill = (): void => { try { process.kill(-p.pid, "SIGKILL"); } catch { /* already gone */ } };
  signal.addEventListener("abort", kill, { once: true });
  await Promise.all([pump(p.stdout), pump(p.stderr)]);
  return await p.exited;
}

const exec: Executor = async (job, ctx) => {
  const log = createWriteStream(ctx.logPath);
  try {
    if (!existsSync(join(worktree, ".git"))) {
      if ((await sh(["git", "worktree", "add", "--detach", worktree, job.sha], repo, log, ctx.signal)) !== 0) return { exitCode: 1 };
    }
    if ((await sh(["git", "checkout", "--detach", "-f", job.sha], worktree, log, ctx.signal)) !== 0) return { exitCode: 1 };
    if (!ctx.reuseBuild && (await sh(["bun", "install", "--frozen-lockfile"], worktree, log, ctx.signal)) !== 0) return { exitCode: 1 };
    const flags = ctx.reuseBuild ? ["--no-build"] : [];
    const code = await sh(["bun", "perf/run.ts", ...flags, ...job.specs], worktree, log, ctx.signal, jobEnv(job));
    for (const f of ["report.md", "report.json"]) {
      const src = join(worktree, "perf/results", f);
      if (existsSync(src)) copyFileSync(src, join(ctx.jobDir, f));
    }
    return { exitCode: code };
  } finally {
    await new Promise((r) => log.end(r));
  }
};

recoverCrashed(dir);
console.log(`perf runner: queue ${dir}, worktree ${worktree}`);
for (;;) {
  try {
    const n = await runPending(dir, exec, { load });
    if (n > 0) console.log(`ran ${String(n)} job(s)`);
  } catch (e) {
    console.error(e);
  }
  await Bun.sleep(5000);
}
