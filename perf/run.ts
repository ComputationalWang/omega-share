// `bun run perf`: build, run static + Playwright perf checks, print a report, exit 1 on any budget regression.
// Flags: --no-build (use existing builds), --strict (pending budgets also fail), --soak (also run the 10 min heap soak).
// Env: OMEGA_PERF_MOTION=smooth|basic forces the walk tier (ADR 0037) in every perf context (playwright.config.ts).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXTENSION_SHIPPED_DIR, FIREFOX_SHIPPED_DIR, ROOT, URLS, WEB_DIST_DIR, scripts } from "../e2e/support/apps";
import { BUDGETS, evaluate, renderReport, type Measurement } from "./budgets";
import { RESULTS_DIR, readMetrics, recordMetric } from "./metrics";
import { checkManifest, initialJsGzipKb } from "./static-checks";

const args = new Set(process.argv.slice(2));

function run(cmd: string[], env: Record<string, string> = {}): number {
  console.log(`$ ${cmd.join(" ")}`);
  return Bun.spawnSync(cmd, { cwd: ROOT, stdio: ["inherit", "inherit", "inherit"], env: { ...process.env, ...env } }).exitCode;
}

rmSync(RESULTS_DIR, { recursive: true, force: true });
mkdirSync(RESULTS_DIR, { recursive: true });

if (!args.has("--no-build")) {
  for (const app of ["web", "extension"] as const) {
    // The web build bakes in the server URL; perf serves it via `preview`, so it must match OMEGA_SERVER_PORT.
    const env = app === "web" ? { VITE_SERVER_URL: URLS.server } : {};
    if ("build" in scripts(app) && run(["bun", "run", "--filter", `@omega/${app}`, "build"], env) !== 0) {
      console.error(`build failed for apps/${app}`);
      process.exit(1);
    }
  }
}

// Static checks.
if (existsSync(join(WEB_DIST_DIR, "index.html"))) {
  const b = initialJsGzipKb(WEB_DIST_DIR);
  recordMetric({ id: "site.initialJsGzip", value: b.kb, note: `${String(b.files.length)} initial JS files` });
} else {
  recordMetric({ id: "site.initialJsGzip", pending: "apps/web/dist not built (OME-6)" });
}
// Manifest budgets apply to the shipped builds, not the e2e builds with their extra host permissions.
for (const [browser, dir, prefix] of [["chrome", EXTENSION_SHIPPED_DIR, "ext"], ["firefox", FIREFOX_SHIPPED_DIR, "ext.firefox"]] as const) {
  const manifestPath = join(dir, "manifest.json");
  if (existsSync(manifestPath)) {
    const m = checkManifest(JSON.parse(readFileSync(manifestPath, "utf8")), browser);
    recordMetric({ id: `${prefix}.contentScripts`, value: m.contentScripts });
    const bg: Measurement = { id: `${prefix}.persistentBackground`, value: m.persistentBackground.length };
    recordMetric(m.persistentBackground.length > 0 ? { ...bg, note: m.persistentBackground.join("; ") } : bg);
  } else {
    for (const id of [`${prefix}.contentScripts`, `${prefix}.persistentBackground`]) recordMetric({ id, pending: `${browser} extension not built (OME-7, OME-593)` });
  }
}

// Runtime checks (Playwright, Chromium; the Firefox popup row drives Firefox through Puppeteer/BiDi). Web is served from the production build.
const soak: Record<string, string> = args.has("--soak") ? { OMEGA_PERF_SOAK: "1" } : {};
const pwExit = run(["bunx", "playwright", "test", "--project=perf"], { OMEGA_WEB_MODE: "preview", ...soak });

const measured = new Map(readMetrics().map((m) => [m.id, m]));
const results = BUDGETS.map((b) => evaluate(b, measured.get(b.id)));
const report = renderReport(results);
writeFileSync(join(RESULTS_DIR, "report.md"), report);
writeFileSync(join(RESULTS_DIR, "report.json"), JSON.stringify(results, null, 2));
console.log(`\n${report}\nWritten to perf/results/report.{md,json}`);

const failed = results.some((r) => r.status === "fail" || (args.has("--strict") && r.status === "pending"));
if (pwExit !== 0) console.error("Playwright perf specs failed — see output above.");
process.exit(failed || pwExit !== 0 ? 1 : 0);
