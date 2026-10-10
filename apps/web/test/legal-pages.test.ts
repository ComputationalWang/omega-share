import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as v from "valibot";
import { build } from "vite";
import { REPO_URL } from "../source";
import { startServer, type OmegaServer } from "../../server/src/server";

/**
 * The static legal pages (OME-766, research m9-release-legal §4): Terms, Contact & notices, Licences & credits.
 * Checked as the server serves them: a real `vite build` of apps/web into a scratch dir, served by `mountSite`.
 */
const web = fileURLToPath(new URL("..", import.meta.url));
const LEGAL = [
  { file: "privacy.html", label: "Privacy" },
  { file: "terms.html", label: "Terms" },
  { file: "contact.html", label: "Contact" },
  { file: "licenses.html", label: "Licences" },
] as const;
const NEW_PAGES = LEGAL.filter((p) => p.file !== "privacy.html");

let out = "";
let server: OmegaServer | null = null;
const served = new Map<string, { status: number; type: string; body: string }>();

beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), "omega-legal-"));
  await build({ root: web, configFile: join(web, "vite.config.ts"), logLevel: "silent", build: { outDir: out, emptyOutDir: true, sourcemap: true } });
  server = startServer({ port: 0, hostname: "127.0.0.1", siteOrigin: "http://localhost:5173", staticDir: out });
  for (const name of ["index.html", ...LEGAL.map((p) => p.file)]) {
    const res = await fetch(`http://127.0.0.1:${String(server.port)}/${name}`);
    served.set(name, { status: res.status, type: res.headers.get("content-type") ?? "", body: await res.text() });
  }
}, 60_000);

afterAll(async () => {
  await server?.stop(true);
  if (out !== "") rmSync(out, { recursive: true, force: true });
});

const page = (name: string): string => served.get(name)?.body ?? "";
const footer = (html: string): string => /<footer[^>]*>([\s\S]*?)<\/footer>/.exec(html)?.[1] ?? "";
const main = (html: string): string => /<main[^>]*>([\s\S]*?)<\/main>/.exec(html)?.[1] ?? "";
const metaCsp = (html: string): string => /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1] ?? "";
const decode = (s: string): string => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
/** Visible text of <main>, tags stripped and whitespace collapsed, so assertions don't depend on wrapping. */
const text = (html: string): string => decode(main(html).replace(/<[^>]+>/g, " ").replace(/\s+/g, " "));
const count = (html: string, re: RegExp): number => html.match(re)?.length ?? 0;

describe("every legal page is built, served and CSP-clean", () => {
  for (const { file } of NEW_PAGES) {
    test(`${file} is served as HTML with no inline script or style, the site's CSP and stylesheet`, () => {
      const res = served.get(file);
      expect(res?.status).toBe(200);
      expect(res?.type).toContain("text/html");
      const html = page(file);
      expect(html).not.toMatch(/<script/i);
      expect(html).not.toMatch(/<style/i);
      expect(html).not.toMatch(/\sstyle=/i);
      expect(html).not.toMatch(/\son[a-z]+=/i);
      expect(html).not.toMatch(/javascript:/i);
      expect(metaCsp(html)).not.toBe("");
      expect(metaCsp(html)).toBe(metaCsp(page("index.html")));
      expect(html).toMatch(/<link rel="stylesheet"[^>]*href="\/assets\/[^"]+\.css"/);
      // The Source placeholder is filled at build time, like the footer's.
      expect(html).not.toContain("%OMEGA_SOURCE_URL%");
    });

    test(`${file} has the a11y basics: lang, a title, one h1, main and footer landmarks, the privacy page's look`, () => {
      const html = page(file);
      expect(html).toMatch(/<html lang="en">/);
      expect(html).toMatch(/<title>[^<]+ · omega-share<\/title>/);
      expect(count(html, /<h1[\s>]/g)).toBe(1);
      expect(count(html, /<main[\s>]/g)).toBe(1);
      expect(html).toMatch(/<main class="privacy">/);
      expect(count(html, /<footer[\s>]/g)).toBe(1);
    });
  }

  for (const { file, label } of LEGAL) {
    test(`${file}'s footer links Privacy · Terms · Contact · Licences · Source and marks ${label} as the current page`, () => {
      const f = footer(page(file));
      const links = [...f.matchAll(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map((m) => [m[1], m[2]]);
      expect(links).toEqual([
        ["/privacy.html", "Privacy"],
        ["/terms.html", "Terms"],
        ["/contact.html", "Contact"],
        ["/licenses.html", "Licences"],
        [REPO_URL, "Source"],
      ]);
      expect(count(f, /aria-current="page"/g)).toBe(1);
      expect(f).toMatch(new RegExp(`aria-current="page">${label}</a>`));
    });
  }

  test("the colours these pages use pass WCAG AA (4.5:1) on the page background", () => {
    const css = readFileSync(join(web, "src", "style.css"), "utf8");
    const color = (name: string): string => new RegExp(`--${name}: (#[0-9a-f]{6});`, "i").exec(css)?.[1] ?? "";
    const lum = (hex: string): number => {
      const [r, g, b] = [1, 3, 5].map((i) => {
        const c = parseInt(hex.slice(i, i + 2), 16) / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
    };
    const ratio = (a: string, b: string): number => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
    const bg = color("bg");
    for (const fg of ["fg", "muted", "accent"]) expect(ratio(color(fg), bg)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("Terms of use (DSA Art. 14)", () => {
  test("say what the service is, the house rules, how we moderate, takedowns, no warranty and the licences", () => {
    const s = text(page("terms.html"));
    expect(s).toMatch(/we don't host (the )?videos/i);
    // House rules.
    expect(s).toMatch(/illegal content/i);
    expect(s).toMatch(/harass/i);
    expect(s).toMatch(/sexual content involving (children|minors)/i);
    expect(s).toMatch(/spam/i);
    // Moderation (Art. 14(1)): a person reads reports, no automated moderation beyond the title blocklist, takedowns.
    expect(s).toMatch(/at least (once a day|daily)/i);
    expect(s).toMatch(/no automated moderation/i);
    expect(s).toMatch(/blocklist/i);
    expect(s).toMatch(/take (a room|rooms) down/i);
    expect(s).toMatch(/complain/i);
    // Changes (Art. 14(2)) and the current version's date.
    expect(s).toMatch(/last (changed|updated):? \d{4}-\d{2}-\d{2}/i);
    expect(s).toMatch(/as is/i);
    expect(s).toMatch(/no warranty/i);
    expect(s).toMatch(/AGPL/);
    expect(s).toMatch(/CC BY-SA 4\.0/);
    expect(main(page("terms.html"))).toContain('href="/contact.html"');
    expect(main(page("terms.html"))).toContain('href="/licenses.html"');
  });
});

describe("Contact & notices (DSA Arts 11, 12, 16)", () => {
  test("explain the in-room report, the notice route with its four elements, deletion, and link the repo's issues", () => {
    const html = page("contact.html");
    const s = text(html);
    expect(s).toMatch(/Report room/);
    expect(s).toMatch(/what happens next/i);
    // Art. 11 and 12 points of contact.
    expect(s).toMatch(/European Commission/);
    expect(s).toMatch(/single point of contact/i);
    expect(s).toMatch(/languages?/i);
    // Art. 16(2) (a)-(d) and the CSAM exception to (c).
    expect(s).toMatch(/why/i);
    expect(s).toMatch(/exact (web )?address/i);
    expect(s).toMatch(/your name and email/i);
    expect(s).toMatch(/good faith/i);
    expect(s).toMatch(/child sexual abuse/i);
    expect(s).toMatch(/delet/i);
    expect(main(html)).toContain(`href="${REPO_URL}/issues"`);
  });

  test("never invents the operator's identity: it is a clearly marked placeholder until the board supplies it", () => {
    const html = page("contact.html");
    expect(html).toMatch(/data-placeholder="operator"/);
    const block = /<[a-z]+ [^>]*data-placeholder="operator"[^>]*>([\s\S]*?)<\/(section|div|p)>/.exec(html)?.[1] ?? "";
    expect(block).toMatch(/not (yet )?published/i);
    expect(html).not.toMatch(/@[a-z0-9-]+\.[a-z]{2,}/i);
  });
});

describe("Licences & credits", () => {
  test("offers the source (AGPL-3.0 §13) and credits the art under CC BY-SA 4.0", () => {
    const html = page("licenses.html");
    const s = text(html);
    expect(s).toMatch(/GNU Affero General Public License/);
    expect(s).toMatch(/AGPL-3\.0-only/);
    expect(main(html)).toContain(`href="${REPO_URL}"`);
    expect(s).toMatch(/CC BY-SA 4\.0/);
    expect(main(html)).toContain('href="https://creativecommons.org/licenses/by-sa/4.0/"');
    expect(main(html)).toContain(`href="${REPO_URL}/tree/main/assets"`);
    expect(s).toMatch(/not affiliated/i);
  });

  /** Every third-party package the build actually bundles, read from its sourcemaps (`@omega/*` is ours). */
  const bundled = (): Map<string, string> => {
    const dirs = new Map<string, string>();
    const assets = join(out, "assets");
    for (const name of readdirSync(assets).filter((f) => f.endsWith(".js.map"))) {
      const map = v.parse(v.object({ sources: v.array(v.string()) }), JSON.parse(readFileSync(join(assets, name), "utf8")));
      for (const src of map.sources) {
        const m = /^(.*node_modules\/((?:@[^/]+\/)?[^/]+))\//.exec(src);
        if (m?.[1] === undefined || m[2] === undefined || m[2].startsWith("@omega/")) continue;
        dirs.set(m[2], resolve(assets, m[1]));
      }
    }
    return dirs;
  };
  const Pkg = v.object({ license: v.string(), dependencies: v.optional(v.record(v.string(), v.string())), author: v.optional(v.unknown()) });

  test("lists exactly the bundled third-party packages, each with its licence and copyright line, plus the licence texts", () => {
    const html = page("licenses.html");
    const deps = bundled();
    expect(deps.size).toBeGreaterThan(0);
    const listed = [...html.matchAll(/data-package="([^"]+)"/g)].map((m) => m[1]);
    expect(listed.toSorted()).toEqual([...deps.keys()].toSorted());
    for (const [name, dir] of deps) {
      const pkg = v.parse(Pkg, JSON.parse(readFileSync(join(dir, "package.json"), "utf8")));
      const entry = new RegExp(`<li data-package="${name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}" data-license="([^"]+)">([\\s\\S]*?)</li>`).exec(html);
      expect(entry?.[1]).toBe(pkg.license);
      const entryText = decode((entry?.[2] ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " "));
      const licenseFile = readdirSync(dir).find((f) => /^licen[cs]e/i.test(f));
      const copyright = licenseFile === undefined ? null : (/^copyright.*$/im.exec(readFileSync(join(dir, licenseFile), "utf8"))?.[0] ?? null);
      if (copyright !== null) expect(entryText).toContain(copyright.trim().replace(/\s+/g, " "));
      else expect(entryText).toMatch(/Copyright/);
    }
    const s = text(html);
    const licences = new Set([...html.matchAll(/data-license="([^"]+)"/g)].map((m) => m[1]));
    if (licences.has("MIT")) expect(s).toContain("Permission is hereby granted, free of charge, to any person obtaining a copy");
    if (licences.has("ISC")) expect(s).toContain("Permission to use, copy, modify, and/or distribute this software for any purpose");
    for (const l of licences) expect(l === "MIT" || l === "ISC").toBe(true);
  });

  test("covers every production dependency of apps/web (bun pm ls) that isn't a workspace package", () => {
    const pkg = v.parse(Pkg, JSON.parse(readFileSync(join(web, "package.json"), "utf8")));
    const prod = Object.entries(pkg.dependencies ?? {})
      .filter(([, range]) => !range.startsWith("workspace:"))
      .map(([name]) => name);
    expect(prod.length).toBeGreaterThan(0);
    for (const name of prod) expect(page("licenses.html")).toContain(`data-package="${name}"`);
  });
});
