// OME-842: screenshot of preview/popup-states.html (the three popup state vignettes in a mock of the real popup) at 1× and 2× device
// pixels, to preview/ui-popup-states@1x|2x.png. Not part of the zero-dependency build: uses the repo's Playwright + Chromium.
// Run: bun assets/src/shoot-popup-states.ts (runs the deterministic build first). Nothing animates, so re-runs leave git clean.
import { chromium } from "@playwright/test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const PREVIEW = join(import.meta.dir, "..", "preview");
const build = Bun.spawnSync(["bun", join(import.meta.dir, "build.ts")]);
if (build.exitCode !== 0) throw new Error(build.stderr.toString());
const browser = await chromium.launch();
try {
  for (const scale of [1, 2]) {
    const page = await browser.newPage({ viewport: { width: 1200, height: 600 }, deviceScaleFactor: scale });
    await page.goto(pathToFileURL(join(PREVIEW, "popup-states.html")).href, { waitUntil: "networkidle" });
    await page.waitForSelector("body[data-ready]", { state: "attached" });
    await page.locator("#popup-states").screenshot({ path: join(PREVIEW, `ui-popup-states@${String(scale)}x.png`), caret: "hide" });
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(build.stdout.toString().split("\n").filter((l) => l.startsWith("popup state")).join("\n"));
