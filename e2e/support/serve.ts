// The launcher every e2e server goes through (OME-821):
//   bun e2e/support/serve.ts --port <n> --watch <pid> -- <command…>
// Refuses a port someone else holds (naming the owner), writes the owner file, runs the command in a process group of
// its own, and takes that group down when it gets SIGTERM/SIGINT/SIGHUP or when the watched process (the Playwright
// runner or worker that started it) is gone, so a run that ends, fails or is killed leaves no server behind.
// `--watch 0` starts a standalone server that later runs of the same agent at the same HEAD may reuse; it stays up
// until `bun run e2e:reap`. One argument after `--` runs through `sh -c`; several are an argv.
import { spawn } from "node:child_process";
import { agentIdentity } from "./ports";
import { claimOwner, decideReuse, describeOwner, headSha, ownerAlive, procStart, readOwner, removeOwner, writeOwner, type Owner } from "./owner";
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
const flag = (name: string, min: number): number => {
  const i = opts.indexOf(name);
  const n = Number(i < 0 ? NaN : opts[i + 1]);
  if (!Number.isInteger(n) || n < min) usage(`${name} needs an integer ≥ ${String(min)}`);
  return n;
};
const port = flag("--port", 1);
const watch = flag("--watch", 0);

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

// Claim the port before anything runs: a launcher that can't record its server never starts one. The group isn't
// known yet, so the claim names the launcher's own pid until the server is up.
const self = procStart(process.pid);
const owner: Owner = { port, pid: process.pid, pidStart: self, pgid: process.pid, pgidStart: self, agent, sha, cmd: command.join(" "), startedAt: new Date().toISOString(), watch };
let claimed = false;
try {
  claimed = claimOwner(owner);
} catch (e) {
  console.error(`omega e2e: can't write the owner file for port ${String(port)}: ${String(e)}`);
  process.exit(1);
}
if (!claimed) {
  const other = readOwner(port);
  console.error(`omega e2e: port ${String(port)} was just claimed by ${other === null ? "another launcher" : describeOwner(other)}`);
  process.exit(1);
}

const child = spawn(file, args, { stdio: "inherit", detached: true });
child.once("error", (e) => {
  console.error(`omega e2e: could not start ${owner.cmd}: ${e.message}`);
  removeOwner(port, undefined, process.pid);
  process.exit(1);
});
const pgid = child.pid;
if (pgid === undefined) {
  // spawn failed; the "error" handler above reports it and exits.
  await new Promise(() => undefined);
  process.exit(1);
}

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
try {
  writeOwner({ ...owner, pgid, pgidStart: procStart(pgid) });
} catch (e) {
  console.error(`omega e2e: can't record the server for port ${String(port)}, stopping it: ${String(e)}`);
  signalGroup("SIGKILL");
  removeOwner(port, undefined, process.pid);
  process.exit(1);
}
for (const s of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(s, stop);
const watchdog = setInterval(() => {
  if (watch === 0) return;
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
