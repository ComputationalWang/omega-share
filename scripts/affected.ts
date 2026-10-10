// `bun run affected <base> [head] [--run [--e2e]]` (OME-820): the specs a diff needs, from `e2e/affected.json`.
// The engineer pastes its last lines into the review hand-off; QA's PR review runs the perf and e2e-real it names
// (ADR 0036, ADR 0041 §1). CI runs the deterministic e2e lanes, so `--run` runs them only with `--e2e`.
// The diff is `git diff base...head`: what head adds since it left base, so a PR's own changes.
import { affectedArgs, loadManifest, select } from "./affected-lib";

const ROOT = new URL("..", import.meta.url).pathname;
const PERF_LOCK = `flock ${process.env["XDG_RUNTIME_DIR"] ?? "/tmp"}/omega-share-perf.lock`;

function git(...args: string[]): string[] {
  const r = Bun.spawnSync(["git", ...args], { cwd: ROOT });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString().trim()}`);
  return r.stdout.toString().split("\n").filter((l) => l !== "");
}

function sh(cmd: string): number {
  console.log(`\n$ ${cmd}`);
  return Bun.spawnSync(["bash", "-c", cmd], { cwd: ROOT, stdio: ["inherit", "inherit", "inherit"] }).exitCode;
}

function parseArgs(): ReturnType<typeof affectedArgs> {
  try {
    return affectedArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
}

const args = parseArgs();
const changed = git("diff", "--name-only", "--no-renames", `${args.base}...${args.head}`);
const existing = new Set(git("ls-tree", "-r", "--name-only", args.head));
const s = select(loadManifest(`${ROOT}e2e/affected.json`), changed, existing);

const list = (xs: readonly string[]) => (xs.length === 0 ? "none" : xs.join(" "));
const perfCmd = s.full ? `${PERF_LOCK} bun run perf` : s.perf.length > 0 ? `${PERF_LOCK} bun run perf ${s.perf.join(" ")}` : null;
const realCmd = s.real.length > 0 ? `bun run e2e:real ${s.real.join(" ")}` : null;
const e2eCmd = s.full ? "bun run e2e" : s.e2e.length > 0 ? `bun run --filter @omega/extension build:e2e && bunx playwright test --project=e2e --project=e2e-sync --project=e2e-tunnel ${s.e2e.join(" ")}` : null;

console.log(`affected ${args.base}...${args.head}: ${String(changed.length)} file(s) changed`);
for (const r of s.reasons) console.log(`  full suite: ${r}`);
console.log(`selection: ${s.full ? "FULL SUITE" : "targeted"}`);
console.log(`  e2e (CI runs these): ${s.full ? "all lanes" : list(s.e2e)}`);
console.log(`  perf: ${s.full ? "all (flocked)" : list(s.perf)}`);
console.log(`  e2e-real: ${list(s.real)}`);
console.log(`  run: ${[perfCmd, realCmd].filter((c) => c !== null).join(" ; ") || "nothing beyond bun run check"}`);

if (args.run) {
  let failed = 0;
  for (const cmd of [perfCmd, realCmd, args.e2e ? e2eCmd : null]) if (cmd !== null && sh(cmd) !== 0) failed++;
  process.exit(failed === 0 ? 0 : 1);
}
