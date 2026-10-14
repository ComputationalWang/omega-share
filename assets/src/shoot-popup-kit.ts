// OME-1041: screenshots of preview/popup-kit.html (toolbar icon states + the pixel popup in every state) at 1× and 2× device
// pixels, to preview/ui-popup-kit-<section>@1x|2x.png. Not part of the zero-dependency build: uses the repo's Playwright + Chromium.
// Run: bun assets/src/shoot-popup-kit.ts (runs the deterministic build first). Animations are paused, so re-runs leave git clean.
import { chromium } from "@playwright/test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const PREVIEW = join(import.meta.dir, "..", "preview");
const build = Bun.spawnSync(["bun", join(import.meta.dir, "build.ts")]);
if (build.exitCode !== 0) throw new Error(build.stderr.toString());
const browser = await chromium.launch();
try {
  for (const scale of [1, 2]) {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: scale });
    await page.goto(pathToFileURL(join(PREVIEW, "popup-kit.html")).href, { waitUntil: "networkidle" });
    await page.waitForSelector("body[data-ready]", { state: "attached" });
    for (const id of ["toolbar", "states"]) {
      await page.locator(`#${id}`).screenshot({ path: join(PREVIEW, `ui-popup-kit-${id}@${String(scale)}x.png`), caret: "hide", animations: "disabled" });
    }
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(build.stdout.toString().split("\n").filter((l) => /^(extension icons|popup)/.test(l)).join("\n"));
