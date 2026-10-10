// `bun run perf:result <job|--latest>`: the verdict of a queued perf run (OME-819). Exit 0 passed, 1 failed, 2 still queued/running (or invalid and requeued), 3 unknown, 4 invalid for good (host load; no verdict).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { jobStatus, queueDir, readResult } from "./queue";
import { readdirSync } from "node:fs";

const dir = queueDir();
const arg = process.argv[2];
const id = arg === "--latest" ? (existsSync(dir) ? readdirSync(dir) : []).filter((n) => existsSync(join(dir, n, "job.json"))).sort().pop() : arg;
if (!id) {
  console.error("usage: bun run perf:result <job-id | --latest>");
  process.exit(3);
}
const status = jobStatus(dir, id);
if (status.state === "unknown") {
  console.log(`${id}: unknown job`);
  process.exit(3);
}
if (status.state === "queued" || status.state === "running") {
  console.log(`${id}: ${status.state}${status.state === "queued" ? ` (position ${String(status.position)})` : ""}. Check again on your next heartbeat; don't sleep.`);
  process.exit(2);
}
const r = readResult(dir, id);
if (!r) process.exit(3);
const secs = Math.round((r.finishedAt - r.startedAt) / 1000);
console.log(`${id}: ${r.status.toUpperCase()} in ${String(secs)} s${r.reason ? `: ${r.reason}` : ""}${r.exitCode === null ? "" : ` (exit ${String(r.exitCode)})`}`);
console.log(`sha ${r.sha}; ${r.specs.length > 0 ? r.specs.join(" ") : "all specs"}${r.motion ? `; motion ${r.motion}` : ""}; requester ${r.requester}${r.issue ? `; issue ${r.issue}` : ""}`);
if (r.loadPeak !== undefined) console.log(`load at start ${String(r.loadAtStart)}, peak ${String(r.loadPeak)} (${String(r.loadSamples?.length ?? 0)} samples in result.json)`);
console.log(`log ${join(dir, id, "run.log")}`);
if (r.status === "invalid") {
  console.log(r.requeuedAs ? `Not a verdict: requeued as ${r.requeuedAs}. Read that one on your next heartbeat.` : "Not a verdict: the host stayed busy. Find what is loading it (agents' local e2e) and submit again.");
  process.exit(r.requeuedAs ? 2 : 4);
}
const report = join(dir, id, "report.md");
if (existsSync(report)) console.log(`\n${readFileSync(report, "utf8")}`);
process.exit(r.status === "passed" ? 0 : 1);
