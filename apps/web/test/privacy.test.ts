import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { REPO_URL } from "../source";

/**
 * The privacy notice (OME-411, threat model §4.4 / S10) is checked as the built site serves it:
 * a real `vite build` with this app's config into a scratch dir.
 */
const root = fileURLToPath(new URL("..", import.meta.url));
let out = "";
let index = "";
let privacy = "";

beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), "omega-privacy-"));
  await build({ root, configFile: join(root, "vite.config.ts"), logLevel: "silent", build: { outDir: out, emptyOutDir: true, sourcemap: false } });
  index = await Bun.file(join(out, "index.html")).text();
  const page = Bun.file(join(out, "privacy.html"));
  privacy = (await page.exists()) ? await page.text() : "";
}, 30_000);

afterAll(() => {
  if (out !== "") rmSync(out, { recursive: true, force: true });
});

const footer = (page: string): string => /<footer[^>]*>([\s\S]*?)<\/footer>/.exec(page)?.[1] ?? "";
const metaCsp = (page: string): string => /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(page)?.[1] ?? "";
/** Visible text, whitespace collapsed, so assertions don't depend on line wrapping. */
const text = (page: string): string =>
  (/<main[^>]*>([\s\S]*?)<\/main>/.exec(page)?.[1] ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("privacy notice (OME-411)", () => {
  test("the site footer links the notice right next to the AGPL Source link, same tab", () => {
    const f = footer(index);
    expect(f).toMatch(/data-testid="source-link"[^>]*>Source<\/a>\s*(?:·\s*)?<a href="\/privacy\.html" data-testid="privacy-link">Privacy<\/a>/);
  });

  test("is built as its own static page: no script at all, the same CSP as the site, the site's stylesheet", () => {
    expect(privacy).not.toBe("");
    expect(privacy).not.toMatch(/<script/i);
    expect(privacy).not.toMatch(/\son[a-z]+=/i);
    expect(metaCsp(privacy)).toBe(metaCsp(index));
    expect(metaCsp(privacy)).not.toBe("");
    expect(privacy).toMatch(/<link rel="stylesheet"[^>]*href="\/assets\/[^"]+\.css"/);
  });

  test("its footer carries the same Source link and marks Privacy as the current page", () => {
    const f = footer(privacy);
    expect(f).toContain(`href="${REPO_URL}"`);
    expect(f).toMatch(/<a href="\/privacy\.html" data-testid="privacy-link" aria-current="page">Privacy<\/a>/);
  });

  test("says what is stored where, and for how long", () => {
    const t = text(privacy);
    // In the browser only.
    expect(t).toMatch(/nickname and avatar are stored in your browser/i);
    // Room rows on disk: what they hold, hashes not tokens.
    expect(t).toMatch(/title/i);
    expect(t).toMatch(/layout/i);
    expect(t).toMatch(/hash/i);
    // What is not stored.
    expect(t).toMatch(/no IP addresses/i);
    expect(t).toMatch(/no accounts/i);
    expect(t).toMatch(/no cookies/i);
    // Retention.
    expect(t).toMatch(/nightly backups[^.]*14 days/i);
    expect(t).toMatch(/rate limit[^.]*in memory/i);
  });

  test("has a Reports section that says what a report keeps, for how long, and that nothing about the reporter is kept (ADR 0033 §3, OME-601)", () => {
    expect(privacy).toMatch(/<h2 id="reports">Reports<\/h2>/);
    const t = text(privacy);
    const reports = /Reports (.*?) Backups and logs/.exec(t)?.[1] ?? /Reports (.*?) Videos/.exec(t)?.[1] ?? "";
    expect(reports).toMatch(/goes to the people who run omega-share only/i);
    expect(reports).toMatch(/reason/i);
    expect(reports).toMatch(/note/i);
    expect(reports).toMatch(/title/i);
    expect(reports).toMatch(/address of the video/i);
    expect(reports).toMatch(/email addresses, IP addresses and phone numbers/i);
    expect(reports).toMatch(/nothing about you/i);
    expect(reports).toMatch(/deleted 30 days/i);
    // Backups prune by count, not age, so a report can outlast a fixed day count after an outage (QA, OME-604).
    expect(reports).toMatch(/the last 14 nightly backups/i);
    expect(reports).not.toMatch(/44 days/);
  });

  test("has a linkable Extension section that the Web Store listing points to (R1, OME-509)", () => {
    expect(privacy).toMatch(/<h2 id="extension">The browser extension<\/h2>/);
    const section = text(`<main>${/<h2 id="extension">[\s\S]*?(?=<h2|<\/main>)/.exec(privacy)?.[0] ?? ""}</main>`);
    // What it reads, and when.
    expect(section).toMatch(/only when you open (it|the extension)/i);
    expect(section).toMatch(/addresses of the videos embedded in that page/i);
    expect(section).toMatch(/share token/i);
    // Where it goes: the chosen server only, on a click.
    expect(section).toMatch(/only to the omega-share server you chose/i);
    expect(section).toMatch(/when you click Share or Add to queue/i);
    // What it keeps.
    expect(section).toMatch(/server address[^.]*stored in the extension/i);
    // Limited Use.
    expect(section).toMatch(/never sold/i);
    expect(section).toMatch(/no analytics/i);
  });
});
