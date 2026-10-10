import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { amoClient, amoCredentialsFromEnv, statusReport, submitNotes, submitProblems } from "./amo";
import { buildStorePackage, packageVersion } from "./package";
import { buildSourcesPackage } from "./sources";

// `bun run ext:amo status|submit` (OME-757): the Firefox add-on through the AMO API. The key comes from AMO_JWT_ISSUER
// and AMO_JWT_SECRET in the environment. Policy (ADR 0038): anyone may run `status`; `submit` only from a CEO-filed
// release issue, after QA signed off on this SHA, with a version bump.
const REPO = join(import.meta.dir, "..", "..", "..");
const OUT = join(import.meta.dir, "..", ".output");
const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "status") await status();
  else if (command === "submit") await submit(submitNotes(args, (path) => readFileSync(path, "utf8")));
  else {
    console.error("usage: bun run ext:amo status | submit [--notes <text> | --notes-file <path>] (AMO_JWT_ISSUER and AMO_JWT_SECRET in the environment)");
    process.exit(2);
  }
} catch (e) {
  console.error(`ext:amo ${command ?? ""}: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

async function status(): Promise<void> {
  const amo = amoClient({ credentials: amoCredentialsFromEnv(process.env) });
  const [addon, versions] = await Promise.all([amo.addon(), amo.versions()]);
  console.log(statusReport(addon, versions));
}

async function submit(notes: string | undefined): Promise<void> {
  const amo = amoClient({ credentials: amoCredentialsFromEnv(process.env) });
  const version = packageVersion();
  const built = { firefox: join(OUT, `omega-share-${version}-firefox.zip`), sources: join(OUT, `omega-share-${version}-sources.zip`) };
  for (const path of Object.values(built)) if (!existsSync(path)) throw new Error(`${path} is missing: run bun run ext:store first`);

  const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: REPO, encoding: "utf8" }).split("\n").filter((line) => line.trim() !== "");
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
  const scratch = mkdtempSync(join(tmpdir(), "omega-amo-"));
  let fresh: { firefox: string; sources: string };
  try {
    console.log("rebuilding the Firefox and sources zips to compare hashes…");
    fresh = { firefox: (await buildStorePackage({ outDir: scratch, browser: "firefox" })).sha256, sources: sha256(buildSourcesPackage({ outDir: scratch }).zipPath) };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const hashes = { firefox: { built: sha256(built.firefox), fresh: fresh.firefox }, sources: { built: sha256(built.sources), fresh: fresh.sources } };
  const problems = submitProblems({ local: version, amoVersions: (await amo.versions()).map((v) => v.version), dirty, hashes });
  if (problems.length > 0) throw new Error(`refusing to submit:\n- ${problems.join("\n- ")}`);

  console.log(`uploading ${basename(built.firefox)} (listed) from ${head}…`);
  const uuid = await amo.upload(readFileSync(built.firefox), basename(built.firefox));
  const created = await amo.createVersion(uuid, readFileSync(built.sources), basename(built.sources), notes === undefined ? {} : { notes });
  const addon = await amo.addon();
  console.log(
    [
      `submitted ${created.version} (listed) for review${notes === undefined ? ", no release notes" : " with release notes"}`,
      `  version: ${created.edit_url ?? `https://addons.mozilla.org/en-US/developers/addon/${addon.slug}/versions/${String(created.id)}`}`,
      `  commit:  ${head}`,
      `  ${basename(built.firefox)} sha256 ${hashes.firefox.built}`,
      `  ${basename(built.sources)} sha256 ${hashes.sources.built}`,
    ].join("\n"),
  );
}
