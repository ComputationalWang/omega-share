// `bun run perf:submit [--issue OME-n] [--sha <sha>] [--requester <name>] [--motion smooth|basic] [perf/<name>.perf.ts ...]`: queue a perf run and return at once.
// End your run after this; read the verdict on your next heartbeat with `bun run perf:result <job>` (OME-819). Never sleep/poll for it.
import { jobStatus, queueDir, submitJob } from "./queue";

const git = (...args: string[]): string => {
  const r = Bun.spawnSync(["git", ...args], { stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};

const specs: string[] = [];
const opt: Record<string, string> = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i] ?? "";
  if (a === "--issue" || a === "--sha" || a === "--requester" || a === "--motion") opt[a.slice(2)] = argv[++i] ?? "";
  else specs.push(a);
}

try {
  const sha = git("rev-parse", opt["sha"] ?? "HEAD");
  if (!opt["sha"] && git("status", "--porcelain", "--", "apps", "packages", "assets", "package.json", "bun.lock", "tsconfig.base.json", "perf", "e2e") !== "") {
    console.error("warning: uncommitted changes are not in the job; the runner measures the committed sha only");
  }
  const dir = queueDir();
  const motion = opt["motion"];
  if (motion !== undefined && motion !== "smooth" && motion !== "basic") throw new Error(`--motion must be smooth or basic, got ${motion}`);
  const requester = opt["requester"] ?? process.env["PAPERCLIP_AGENT_NAME"] ?? process.env["USER"] ?? "unknown";
  const id = submitJob(dir, { sha, specs, requester, issue: opt["issue"] ?? "", ...(motion ? { motion } : {}) });
  const status = jobStatus(dir, id);
  console.log(`queued ${id} (sha ${sha.slice(0, 7)}, ${specs.length > 0 ? specs.join(" ") : "all specs"}${motion ? `, motion ${motion}` : ""}), position ${status.state === "queued" ? String(status.position) : "?"}`);
  console.log(`Read it on your next heartbeat: bun run perf:result ${id}   (don't sleep or poll)`);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
