// OME-1642: measures every recipe in preview/sound.html headlessly (OfflineAudioContext, the page's engine mirror) and prints
// peak and RMS in dBFS. Exits 1 if any sound peaks above -12 dBFS at master volume 1. Not part of the zero-dependency build:
// uses the repo's Playwright + Chromium. Run: bun assets/src/sound-meter.ts
import { chromium } from "@playwright/test";
import { join } from "node:path";

interface Row { name: string; len: number; peak: number; rms: number; peakDefault: number }

// Served over http: Chromium won't fetch ../sound/recipes.json from a file:// page.
const root = join(import.meta.dir, "..");
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => new Response(Bun.file(join(root, new URL(req.url).pathname.replace(/\.\.+/g, "")))) });
const browser = await chromium.launch();
let rows: Row[];
try {
  const p = await browser.newPage();
  await p.goto(`${server.url.href}preview/sound.html`);
  await p.waitForFunction(() => (globalThis as unknown as { ready?: boolean }).ready === true);
  rows = await p.evaluate(() => (globalThis as unknown as { measure: () => Promise<Row[]> }).measure());
} finally {
  await browser.close();
  await server.stop();
}
const pad = (s: string, n: number): string => s.padEnd(n);
console.log(`${pad("sound", 13)}${pad("length", 9)}${pad("peak@100%", 11)}${pad("rms@100%", 10)}peak@40%`);
for (const r of rows) console.log(`${pad(r.name, 13)}${pad(`${r.len.toFixed(2)} s`, 9)}${pad(r.peak.toFixed(1), 11)}${pad(r.rms.toFixed(1), 10)}${r.peakDefault.toFixed(1)}`);
const over = rows.filter((r) => r.peak > -12);
console.log(over.length === 0 ? "all peaks ≤ -12 dBFS at master volume 1" : `OVER -12 dBFS: ${over.map((r) => r.name).join(", ")}`);
process.exit(over.length === 0 ? 0 : 1);
