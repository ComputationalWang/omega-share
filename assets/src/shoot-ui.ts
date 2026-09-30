// Screenshots of preview/ui.html (sets c, e, the M1b TV and the M2 live chrome, set f safety states) at 1× for design review. Not part of the zero-dependency build:
// uses the repo's Playwright + Chromium. Run: bun assets/src/shoot-ui.ts (after bun assets/src/build.ts).
import { chromium } from "@playwright/test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const PREVIEW = join(import.meta.dir, "..", "preview");
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1040, height: 900 }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(join(PREVIEW, "ui.html")).href, { waitUntil: "networkidle" });
  for (const id of ["landing", "states", "room", "playback", "playback-states", "tv", "live", "live-states", "safety", "safety-states"]) {
    await page.locator(`#${id}`).screenshot({ path: join(PREVIEW, `ui-${id}.png`) });
  }
} finally {
  await browser.close();
}
