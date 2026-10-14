/**
 * `bun run blackbox`: the TS server suite (apps/server/test, the referee) against the Rust binary.
 * Fails when a test listed in manifest.json stops passing; lists tests that pass but aren't listed
 * (grow the manifest with `--write-manifest`). See PORTING.md "The black-box suite (S8)".
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { evaluate, parseJunit, type TestResult } from "./report";

const root = resolve(import.meta.dir, "../../..");
const testDir = "apps/server/test";
const manifestPath = join(import.meta.dir, "manifest.json");
/** Shell-script tests (deploy kit, monitor, tunnel): not server code, nothing to compare (category E). */
const NOT_SERVER = ["deploy-kit.test.ts", "monitor.test.ts", "tunnel-script.test.ts"];

function run(cmd: string[], env: Record<string, string | undefined> = {}, quiet = false): number {
  const proc = Bun.spawnSync(cmd, {
    cwd: root,
    env: { ...process.env, ...env },
    stdout: quiet ? "ignore" : "inherit",
    stderr: quiet ? "ignore" : "inherit",
  });
  return proc.exitCode;
}

const write = process.argv.includes("--write-manifest");
const dump = process.argv.find((a) => a.startsWith("--dump="))?.slice("--dump=".length);
const only = process.argv
  .find((a) => a.startsWith("--files="))
  ?.slice("--files=".length)
  .split(",");

// cargo knows where its target dir is (CARGO_TARGET_DIR, relative paths, build.target-dir).
const metadata: unknown = JSON.parse(
  Bun.spawnSync(["cargo", "metadata", "--format-version", "1", "--no-deps", "--locked"], {
    cwd: root,
  }).stdout.toString(),
);
const targetDir =
  typeof metadata === "object" && metadata !== null && "target_directory" in metadata
    ? String(metadata.target_directory)
    : join(root, "target");
if (run(["cargo", "build", "--locked", "--features", "test-hooks", "--bin", "omega-server"]) !== 0) process.exit(2);
const bin = join(targetDir, "debug/omega-server");
if (!existsSync(bin)) {
  console.error(`no binary at ${bin}`);
  process.exit(2);
}

const files = (only ?? readdirSync(join(root, testDir)).filter((f) => f.endsWith(".test.ts")))
  .filter((f) => !NOT_SERVER.includes(f))
  .map((f) => `${testDir}/${f}`);
/** One pass of the suite with `OMEGA_SERVER_BIN=bin`. Files run one after another, and each test spawns its own process, so the load stays at one binary. */
function suite(bin: string): TestResult[] {
  const scratch = mkdtempSync(join(tmpdir(), "omega-blackbox-"));
  const junit = join(scratch, "junit.xml");
  // Hundreds of expected failures: the verdict below is the output; --verbose shows bun's own.
  const quiet = !process.argv.includes("--verbose");
  run(
    ["bun", "test", "--timeout", "4000", "--reporter=junit", `--reporter-outfile=${junit}`, ...files],
    { OMEGA_SERVER_BIN: bin },
    quiet,
  );
  const results = parseJunit(existsSync(junit) ? readFileSync(junit, "utf8") : "");
  rmSync(scratch, { recursive: true, force: true });
  return results;
}

const results = suite(bin);
if (results.length === 0) {
  console.error("the suite produced no results");
  process.exit(2);
}
// Only to find manifest candidates (--dump, --write-manifest), not on every check: a second pass
// with a binary that cannot start, whatever still passes never needed a server.
const wantsCandidates = dump !== undefined || write;
const serverFree = new Set(
  wantsCandidates
    ? suite("/nonexistent/omega-server")
        .filter((t) => t.status === "pass")
        .map((t) => t.id)
    : [],
);

const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
const listed =
  typeof parsed === "object" && parsed !== null && "tests" in parsed && Array.isArray(parsed.tests)
    ? parsed.tests.filter((t): t is string => typeof t === "string")
    : [];
if (dump !== undefined) writeFileSync(dump, JSON.stringify({ results, serverFree: [...serverFree] }));
const verdict = evaluate(results, listed, serverFree);
if (!wantsCandidates) verdict.unlisted = [];

console.log(
  `\nblack-box: ${String(verdict.counts.pass)} pass, ${String(verdict.counts.fail)} fail, ` +
    `${String(verdict.counts["not-black-box"])} not-black-box, ${String(verdict.counts.skip)} skipped, ${wantsCandidates ? `${String(verdict.counts["no-server"])} never start a server ` : ""}` +
    `(${String(listed.length)} in the manifest)`,
);
if (verdict.unlisted.length > 0) {
  console.log(`\n${String(verdict.unlisted.length)} passing but not in the manifest (--write-manifest adds them):`);
  for (const id of verdict.unlisted) console.log(`  + ${id}`);
}
if (write) {
  const all = [...new Set([...listed.filter((id) => !verdict.regressions.includes(id)), ...verdict.unlisted])].sort();
  writeFileSync(manifestPath, `${JSON.stringify({ tests: all }, null, 2)}\n`);
  console.log(`manifest: ${String(all.length)} tests`);
}
if (verdict.regressions.length > 0) {
  console.error(`\n${String(verdict.regressions.length)} manifest tests no longer pass:`);
  for (const id of verdict.regressions) console.error(`  - ${id}`);
  process.exit(1);
}
