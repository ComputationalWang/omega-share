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
});
