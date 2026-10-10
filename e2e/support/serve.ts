// The launcher every e2e server goes through (OME-821):
//   bun e2e/support/serve.ts --port <n> --watch <pid> -- <command…>
// Refuses a port someone else holds (naming the owner), writes the owner file, runs the command in a process group of
// its own, and takes that group down when it gets SIGTERM/SIGINT/SIGHUP or when the watched process (the Playwright
// runner or worker that started it) is gone, so a run that ends, fails or is killed leaves no server behind.
// One argument after `--` runs through `sh -c`; several are an argv.
import { spawn } from "node:child_process";
import { agentIdentity } from "./ports";
import { decideReuse, headSha, ownerAlive, readOwner, removeOwner, writeOwner } from "./owner";
import { portInUse } from "./probe";

function usage(why: string): never {
  console.error(`serve.ts: ${why}\nusage: bun e2e/support/serve.ts --port <n> --watch <pid> -- <command…>`);
  process.exit(2);
}

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
if (sep < 0 || sep === argv.length - 1) usage("no command after --");
const opts = argv.slice(0, sep);
const command = argv.slice(sep + 1);
const flag = (name: string): number => {
  const i = opts.indexOf(name);
  const n = Number(i < 0 ? NaN : opts[i + 1]);
  if (!Number.isInteger(n) || n <= 0) usage(`${name} needs a positive integer`);
  return n;
};
const port = flag("--port");
const watch = flag("--watch");

const agent = agentIdentity();
const sha = headSha();
const decision = decideReuse({ inUse: await portInUse(port), owner: readOwner(port), alive: ownerAlive, agent, sha });
if (decision.kind === "refuse") {
  console.error(`omega e2e: port ${String(port)} ${decision.reason}`);
  process.exit(1);
}
if (decision.kind === "reuse") {
  console.error(`omega e2e: port ${String(port)} already has your server at HEAD; reuse it or run \`bun run e2e:reap\` first.`);
  process.exit(1);
}
if (decision.stale) removeOwner(port);

const [file, ...args] = command.length === 1 ? ["sh", "-c", command.join("")] : command;
if (file === undefined) usage("empty command");
const child = spawn(file, args, { stdio: "inherit", detached: true });
const pgid = child.pid;
if (pgid === undefined) {
  console.error(`omega e2e: could not start ${command.join(" ")}`);
  process.exit(1);
}
writeOwner({ port, pid: process.pid, pgid, agent, sha, cmd: command.join(" "), startedAt: new Date().toISOString() });

const signalGroup = (signal: NodeJS.Signals): void => {
  try {
    process.kill(-pgid, signal);
  } catch {
    // already gone
  }
};
let stopping = false;
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  signalGroup("SIGTERM");
  setTimeout(() => {
    signalGroup("SIGKILL");
  }, 5_000).unref();
};
for (const s of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(s, stop);
const watchdog = setInterval(() => {
  try {
    process.kill(watch, 0);
  } catch {
    stop();
  }
}, 500);
child.once("exit", (code, signal) => {
  clearInterval(watchdog);
  // The command may leave helpers in its group (bun run → vite); none may outlive it.
  signalGroup("SIGKILL");
  removeOwner(port, undefined, process.pid);
  process.exit(code ?? (signal === null ? 1 : 128));
});
