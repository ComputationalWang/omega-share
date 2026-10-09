// Set (k) (OME-541): screenshots of preview/m7.html, one PNG per section, at 1× and 2× device pixels (preview/ui-m7-*@1x|2x.png).
// Not part of the zero-dependency build: uses the repo's Playwright + Chromium. Run: bun assets/src/shoot-m7.ts [section ...]. It runs the
// (deterministic) build first and prints its budget line. Deterministic: animations are stopped and the caret hidden, so re-runs leave git clean.
import { chromium } from "@playwright/test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const PREVIEW = join(import.meta.dir, "..", "preview");
const all = ["m7-pieces", "m7-desktop", "m7-band", "m7-phone", "m7-popout", "m7-away", "m7-watch", "m7-quality", "m7-report", "m7-motion"];
const only = process.argv.slice(2);
const ids = only.length > 0 ? only : all;
const build = Bun.spawnSync(["bun", join(import.meta.dir, "build.ts")]);
if (build.exitCode !== 0) throw new Error(build.stderr.toString());
const budget = build.stdout.toString().split("\n").find((l) => l.startsWith("art total"));
const browser = await chromium.launch();
try {
  for (const scale of [1, 2]) {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: scale, reducedMotion: "no-preference" });
    await page.goto(pathToFileURL(join(PREVIEW, "m7.html")).href, { waitUntil: "networkidle" });
    for (const id of ids) {
      const el = page.locator(`#${id}`);
      if ((await el.count()) === 0) continue;
      await el.screenshot({ path: join(PREVIEW, `ui-${id}@${String(scale)}x.png`), animations: "disabled", caret: "hide" });
    }
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(budget ?? "art total: (build printed no budget line)");
