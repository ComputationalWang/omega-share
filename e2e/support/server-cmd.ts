// Which server the e2e suite runs against (OME-1170, ADR 0050): the Rust binary by default (production runs it), the TS server with E2E_SERVER=bun until S13 deletes it.
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");

export function serverBackend(env: NodeJS.ProcessEnv): "bun" | "rust" {
  const v = env["E2E_SERVER"] ?? "rust";
  if (v !== "bun" && v !== "rust") throw new Error(`E2E_SERVER must be bun or rust, not ${JSON.stringify(v)}`);
  return v;
}

/** cargo knows the target dir (CARGO_TARGET_DIR, config, default). */
function targetDir(env: NodeJS.ProcessEnv): string {
  const set = env["CARGO_TARGET_DIR"];
  if (set !== undefined && set !== "") return resolve(ROOT, set);
  const r = spawnSync("cargo", ["metadata", "--format-version", "1", "--no-deps", "--locked"], { cwd: ROOT, encoding: "utf8" });
  const meta: unknown = JSON.parse(r.stdout);
  if (typeof meta !== "object" || meta === null || !("target_directory" in meta) || typeof meta.target_directory !== "string") throw new Error("cargo metadata gave no target_directory");
  return meta.target_directory;
}

/** The server process to spawn, from the repo root, with the same env either way. */
export function serverProcess(env: NodeJS.ProcessEnv): { command: string; args: string[] } {
  if (serverBackend(env) === "bun") return { command: "bun", args: ["apps/server/src/index.ts"] };
  return { command: join(targetDir(env), "e2e/omega-server"), args: [] };
}

/** Builds the e2e-profile binary (Cargo.toml [profile.e2e]: release without LTO) once per run (the runner calls this; workers only compute the path). */
export function buildRustServer(env: NodeJS.ProcessEnv): void {
  const r = spawnSync("cargo", ["build", "--locked", "--profile", "e2e", "--bin", "omega-server"], { cwd: ROOT, stdio: "inherit", env });
  if (r.status !== 0) throw new Error("cargo build of omega-server failed");
}

/** `serverProcess` as spread-able spawn arguments: `spawnOwned(port, ...serverArgv(), opts)`. */
export function serverArgv(): [string, string[]] {
  const { command, args } = serverProcess(process.env);
  return [command, args];
}
