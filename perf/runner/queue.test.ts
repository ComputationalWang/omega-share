import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jobEnv, jobStatus, readResult, recoverCrashed, runPending, submitJob, type Executor, type Job } from "./queue";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "perf-queue-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const submit = (sha: string, specs: string[] = [], at = Date.now()) =>
  submitJob(dir, { sha, specs, requester: "qa2", issue: "OME-1" }, at);

const ok: Executor = () => Promise.resolve({ exitCode: 0 });

describe("submitJob", () => {
  test("writes job.json and returns at once with a queued status", () => {
    const id = submit("a".repeat(40), ["perf/site.perf.ts"]);
    const job: unknown = JSON.parse(readFileSync(join(dir, id, "job.json"), "utf8"));
    expect(job).toMatchObject({ sha: "a".repeat(40), specs: ["perf/site.perf.ts"], requester: "qa2", issue: "OME-1" });
    expect(jobStatus(dir, id)).toEqual({ state: "queued", position: 1 });
  });

  test("rejects a sha that isn't 40 hex chars and specs that aren't perf specs", () => {
    expect(() => submit("main")).toThrow(/sha/);
    expect(() => submit("a".repeat(40), ["../etc/passwd"])).toThrow(/spec/);
  });

  // OME-733: a forced walk tier per job, so the whole suite can run once on omega.motion=smooth and once on basic (ADR 0037).
  test("a job can force the walk tier; anything but smooth or basic is refused", () => {
    const id = submitJob(dir, { sha: "a".repeat(40), specs: [], requester: "qa", issue: "OME-733", motion: "basic" });
    expect(JSON.parse(readFileSync(join(dir, id, "job.json"), "utf8"))).toMatchObject({ motion: "basic" });
    const bad = { sha: "a".repeat(40), specs: [], requester: "qa", issue: "OME-733", motion: "fast" };
    // @ts-expect-error: a job.json written by hand or an old client can carry any string
    expect(() => submitJob(dir, bad)).toThrow(/motion/);
  });
});

describe("runPending", () => {
  test("runs jobs oldest first", async () => {
    const first = submit("a".repeat(40), [], 1000);
    const second = submit("b".repeat(40), [], 2000);
    const order: string[] = [];
    await runPending(dir, (job) => { order.push(job.id); return Promise.resolve({ exitCode: 0 }); });
    expect(order).toEqual([first, second]);
    expect(jobStatus(dir, first).state).toBe("passed");
  });

  test("runs one job at a time", async () => {
    submit("a".repeat(40), [], 1000);
    submit("b".repeat(40), [], 2000);
    let active = 0;
    let peak = 0;
    await runPending(dir, async () => {
      active++;
      peak = Math.max(peak, active);
      await Bun.sleep(5);
      active--;
      return { exitCode: 0 };
    });
    expect(peak).toBe(1);
  });

  test("a failing exit code is reported failed with the exit code", async () => {
    const id = submit("a".repeat(40));
    await runPending(dir, () => Promise.resolve({ exitCode: 1 }));
    expect(readResult(dir, id)).toMatchObject({ status: "failed", exitCode: 1, sha: "a".repeat(40) });
  });

  test("an executor that throws is failed, and the queue moves on", async () => {
    const bad = submit("a".repeat(40), [], 1000);
    const good = submit("b".repeat(40), [], 2000);
    await runPending(dir, (job) => job.id === bad ? Promise.reject(new Error("checkout exploded")) : Promise.resolve({ exitCode: 0 }));
    expect(readResult(dir, bad)).toMatchObject({ status: "failed", reason: "checkout exploded" });
    expect(jobStatus(dir, good).state).toBe("passed");
  });

  test("an executor that exceeds the timeout is failed rather than hanging", async () => {
    const id = submit("a".repeat(40));
    await runPending(dir, () => new Promise<never>(() => undefined), { timeoutMs: 20 });
    expect(readResult(dir, id)).toMatchObject({ status: "failed", reason: "timed out after 0 s" });
  });

  test("result.json carries requester, issue and times", async () => {
    const id = submit("a".repeat(40), ["perf/site.perf.ts"]);
    await runPending(dir, ok);
    const r = readResult(dir, id);
    expect(r).toMatchObject({ id, status: "passed", requester: "qa2", issue: "OME-1", specs: ["perf/site.perf.ts"] });
    expect(r?.finishedAt).toBeGreaterThanOrEqual(r?.startedAt ?? Infinity);
  });
});

describe("build reuse per sha", () => {
  test("only the first job of a sha builds; a new sha builds again", async () => {
    submit("a".repeat(40), [], 1);
    submit("a".repeat(40), [], 2);
    submit("b".repeat(40), [], 3);
    const reuse: boolean[] = [];
    await runPending(dir, (_job, ctx) => { reuse.push(ctx.reuseBuild); return Promise.resolve({ exitCode: 0 }); });
    expect(reuse).toEqual([false, true, false]);
  });

  test("a sha whose job failed isn't treated as built", async () => {
    submit("a".repeat(40), [], 1);
    submit("a".repeat(40), [], 2);
    const reuse: boolean[] = [];
    await runPending(dir, (_job, ctx) => { reuse.push(ctx.reuseBuild); return Promise.resolve({ exitCode: 1 }); });
    expect(reuse).toEqual([false, false]);
  });
});

describe("recoverCrashed", () => {
  test("a job left running by a dead runner is failed, not left hanging", () => {
    const id = submit("a".repeat(40));
    writeFileSync(join(dir, id, "running.json"), JSON.stringify({ startedAt: 5 }));
    expect(jobStatus(dir, id).state).toBe("running");
    recoverCrashed(dir);
    expect(readResult(dir, id)).toMatchObject({ status: "failed", reason: "runner stopped while the job was running" });
    expect(existsSync(join(dir, id, "running.json"))).toBe(false);
  });
});

describe("jobStatus", () => {
  test("queue position counts the jobs ahead", () => {
    submit("a".repeat(40), [], 1);
    const second = submit("b".repeat(40), [], 2);
    expect(jobStatus(dir, second)).toEqual({ state: "queued", position: 2 });
  });

  test("unknown job", () => {
    expect(jobStatus(dir, "nope").state).toBe("unknown");
  });
});

describe("jobEnv", () => {
  const job = (motion?: "smooth" | "basic"): Job => ({ sha: "a".repeat(40), specs: [], requester: "qa", issue: "OME-733", id: "1", submittedAt: 1, ...(motion ? { motion } : {}) });

  test("a forced tier reaches the perf run as OMEGA_PERF_MOTION", () => {
    expect(jobEnv(job("smooth"))).toEqual({ OMEGA_PERF_MOTION: "smooth" });
    expect(jobEnv(job("basic"))).toEqual({ OMEGA_PERF_MOTION: "basic" });
  });

  test("an unforced job clears OMEGA_PERF_MOTION, so the runner's own env can't force a tier", () => {
    expect(jobEnv(job())).toEqual({ OMEGA_PERF_MOTION: "" });
  });
});
