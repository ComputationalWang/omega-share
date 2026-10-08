// Screenshots of preview/ui.html (sets c, e, the M1b TV and the M2 live chrome, set f safety states, set h owner edit mode / tray / invites, set i rooms you own + emotes,
// set j house rules + queue) at 1×; sets (i) and (j) also at 2× device pixels for design review. Set (j) also shoots preview/store.html into store/ (the Web Store kit). Not part of the zero-dependency build:
// uses the repo's Playwright + Chromium. Run: bun assets/src/shoot-ui.ts (after bun assets/src/build.ts).
import { chromium } from "@playwright/test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const PREVIEW = join(import.meta.dir, "..", "preview");
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1040, height: 900 }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(join(PREVIEW, "ui.html")).href, { waitUntil: "networkidle" });
  for (const id of ["landing", "states", "room", "playback", "playback-states", "tv", "live", "live-states", "safety", "safety-states", "owner", "owner-tray", "owner-states"]) {
    await page.locator(`#${id}`).screenshot({ path: join(PREVIEW, `ui-${id}.png`) });
  }
  // Set (i) (OME-416): each section at 1× and 2× device pixels.
  for (const scale of [1, 2]) {
    const hd = await browser.newPage({ viewport: { width: 1040, height: 900 }, deviceScaleFactor: scale });
    await hd.goto(pathToFileURL(join(PREVIEW, "ui.html")).href, { waitUntil: "networkidle" });
    for (const id of ["rooms", "rooms-closed", "rooms-live", "rooms-states", "house", "house-page", "queue", "setj-states"]) {
      await hd.locator(`#${id}`).screenshot({ path: join(PREVIEW, `ui-${id}@${String(scale)}x.png`) });
    }
    await hd.close();
  }
  // Set (j) (OME-422): the Chrome Web Store promo tile (440×280) and two screenshots (1280×800), exact pixel sizes.
  const store = await browser.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 1 });
  await store.goto(pathToFileURL(join(PREVIEW, "store.html")).href, { waitUntil: "networkidle" });
  for (const [id, file] of [["promo", "promo-440x280"], ["shot-room", "screenshot-1-room"], ["shot-share", "screenshot-2-share"]] as const) {
    await store.locator(`#${id}`).screenshot({ path: join(PREVIEW, "..", "store", `${file}.png`) });
  }
  await store.close();
} finally {
  await browser.close();
}
