// Set (l) (OME-644): screenshots of preview/m8.html, one PNG per section, at 1× and 2× device pixels (preview/ui-m8-*@1x|2x.png).
// Not part of the zero-dependency build: uses the repo's Playwright + Chromium. Run: bun assets/src/shoot-m8.ts [section ...]. It runs the
// (deterministic) build first and prints its budget line. Bubbles are frozen at fixed ages (paused animations, negative delays) and the
// caret is hidden, so re-runs leave git clean.
import { chromium } from "@playwright/test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const PREVIEW = join(import.meta.dir, "..", "preview");
const all = ["m8-pieces", "m8-bubbles", "m8-float", "m8-wheel", "m8-desktop"];
const only = process.argv.slice(2);
const ids = only.length > 0 ? only : all;
const build = Bun.spawnSync(["bun", join(import.meta.dir, "build.ts")]);
if (build.exitCode !== 0) throw new Error(build.stderr.toString());
const budget = build.stdout.toString().split("\n").find((l) => l.startsWith("art total"));
const browser = await chromium.launch();
try {
  for (const scale of [1, 2]) {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: scale, reducedMotion: "no-preference" });
    await page.goto(pathToFileURL(join(PREVIEW, "m8.html")).href, { waitUntil: "networkidle" });
    await page.waitForSelector("body[data-ready]", { state: "attached" });
    for (const id of ids) {
      const el = page.locator(`#${id}`);
      if ((await el.count()) === 0) continue;
      await el.screenshot({ path: join(PREVIEW, `ui-${id}@${String(scale)}x.png`), animations: "allow", caret: "hide" });
    }
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(budget ?? "art total: (build printed no budget line)");
