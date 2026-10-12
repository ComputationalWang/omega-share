import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { buildSha, withBuildInfo } from "../build-info";
import { CHROME_LISTING_URL, FIREFOX_LISTING_URL, installLinks, withInstallLinks } from "../install";
import { REPO_URL } from "../source";
import { startServer, type OmegaServer } from "../../server/src/server";

/**
 * The landing (OME-767, M9 W1): how it works, install links, the site footer, the head tags and a skip link.
 * Checked as the server serves it: a real `vite build` of apps/web into a scratch dir, served by `mountSite`.
 */
const web = fileURLToPath(new URL("..", import.meta.url));
const siteArt = fileURLToPath(new URL("../../../assets/site/", import.meta.url));

/** The three steps of the Dusk doorstep landing (OME-933 design 53e938b): numbered captions, text only. */
const STEPS = ["Find a video", "Share your room", "Watch in sync"] as const;
/** The hero: the desktop room crop (≥1104 px) or the phone/tablet vignette, one file fetched, never both. */
const HERO = { wide: "website-room.png", narrow: "how-3-watch.png" } as const;
/** The four avatars, by id, with their original names (assets/avatars/avatars.json). */
const AVATARS = ["Juno", "Pip", "Mo", "Kiki"] as const;

let out = "";
let server: OmegaServer | null = null;
let built = "";
let served = "";
const base = (): string => `http://127.0.0.1:${String(server?.port ?? 0)}`;

beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), "omega-landing-"));
  await build({ root: web, configFile: join(web, "vite.config.ts"), logLevel: "silent", build: { outDir: out, emptyOutDir: true, sourcemap: false } });
  built = readFileSync(join(out, "index.html"), "utf8");
  server = startServer({ port: 0, hostname: "127.0.0.1", siteOrigin: "http://localhost:5173", staticDir: out });
  served = await (await fetch(`${base()}/`)).text();
}, 60_000);

afterAll(async () => {
  await server?.stop(true);
  if (out !== "") rmSync(out, { recursive: true, force: true });
});

const count = (html: string, re: RegExp): number => html.match(re)?.length ?? 0;
const body = (html: string): string => /<body[^>]*>([\s\S]*)<\/body>/.exec(html)?.[1] ?? "";
const footer = (html: string): string => /<footer[^>]*>([\s\S]*?)<\/footer>/.exec(html)?.[1] ?? "";
const how = (html: string): string => /<section[^>]*id="how"[^>]*>([\s\S]*?)<\/section>/.exec(html)?.[1] ?? "";
const attrs = (tag: string): Record<string, string> => Object.fromEntries([...tag.matchAll(/([a-z-]+)="([^"]*)"/g)].map((a) => [a[1] ?? "", a[2] ?? ""]));
const decode = (s: string): string => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const text = (html: string): string => decode(html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")).trim();

describe("landing: explains the product before asking for anything", () => {
  test("a skip link comes first, and the nickname field is the first control after it", () => {
    // Focusable in document order: links with an href, buttons, inputs (hidden ones aside), selects, textareas.
    const focusables = [...body(served).matchAll(/<(a\s[^>]*href=|button[\s>]|input(?![^>]*type="hidden")[\s>]|select[\s>]|textarea[\s>])[^>]*>/g)].map((m) => m[0]);
    const skip = attrs(focusables[0] ?? "");
    expect(skip["class"]).toContain("skip-link");
    expect(skip["href"]).toBe("#app");
    expect(attrs(focusables[1] ?? "")["id"]).toBe("nickname");
    // The skip target is a plain <main>: no tabindex, so a click in the page leaves focus on <body> (the room's
    // focus-return rules, e.g. the emote wheel's, depend on it). Following the link moves the Tab start point there.
    expect(served).toMatch(/<main id="app">/);
  });

  test("'How it works' sits after the form: a heading and three numbered steps, text only", () => {
    const section = how(served);
    expect(section).not.toBe("");
    expect(served.indexOf('id="how"')).toBeGreaterThan(served.indexOf('id="landing"'));
    expect(section).toMatch(/<h2[^>]*id="how-title"[^>]*>How it works<\/h2>/);
    expect(served).toMatch(/<section[^>]*id="how"[^>]*aria-labelledby="how-title"/);
    expect(section).toMatch(/<ol[\s>]/);
    expect(count(section, /<li[\s>]/g)).toBe(3);
    expect(count(section, /<img[\s>]/g)).toBe(0);
    const s = text(section);
    for (const step of STEPS) expect(s).toContain(step);
  });

  test("the hero is one <picture>: the room crop from 1104 px, else the vignette; sized up front, decorative, not lazy", () => {
    const pic = /<picture[^>]*>([\s\S]*?)<\/picture>/.exec(served)?.[1] ?? "";
    expect(pic).not.toBe("");
    // Before the form in the page (it is first on phones), but never focusable.
    expect(served.indexOf("<picture")).toBeLessThan(served.indexOf('id="landing"'));
    const sources = [...pic.matchAll(/<source\s[^>]*>/g)].map((m) => attrs(m[0]));
    expect(sources).toHaveLength(1);
    const wide = sources[0] ?? {};
    expect(wide["media"]).toBe("(min-width: 1104px)");
    expect(wide["srcset"]).toMatch(/^\/assets\/website-room-[A-Za-z0-9_-]+\.png$/);
    expect([wide["width"], wide["height"]]).toEqual(["656", "536"]);
    const img = attrs(/<img\s[^>]*>/.exec(pic)?.[0] ?? "");
    expect(img["src"]).toMatch(/^\/assets\/how-3-watch-[A-Za-z0-9_-]+\.png$/);
    expect([img["width"], img["height"]]).toEqual(["368", "224"]);
    expect(img["alt"]).toBe("");
    expect(img["loading"]).toBeUndefined();
  });

  test("the hero's caption calls it an illustration and promises no identical room (judge's caution)", () => {
    const fig = /<figcaption[^>]*>([\s\S]*?)<\/figcaption>/.exec(served)?.[1] ?? "";
    expect(text(fig)).toMatch(/illustration/i);
    expect(text(fig)).not.toMatch(/same|step into|exactly/i);
  });

  test("the hero files are served byte for byte from assets/site", async () => {
    const pic = /<picture[^>]*>([\s\S]*?)<\/picture>/.exec(served)?.[1] ?? "";
    const srcs: [string, string][] = [
      [attrs(/<source\s[^>]*>/.exec(pic)?.[0] ?? "")["srcset"] ?? "", HERO.wide],
      [attrs(/<img\s[^>]*>/.exec(pic)?.[0] ?? "")["src"] ?? "", HERO.narrow],
    ];
    for (const [src, file] of srcs) {
      const res = await fetch(`${base()}${src}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("image/png");
      expect(Buffer.from(await res.arrayBuffer()).equals(readFileSync(join(siteArt, file)))).toBe(true);
    }
  });

  test("Enter lobby is the form's one submit; Find or create a room is a separate button outside the form", () => {
    const form = /<form[^>]*id="landing"[^>]*>([\s\S]*?)<\/form>/.exec(served)?.[1] ?? "";
    expect(text(/<button[^>]*data-testid="join-button"[^>]*>[\s\S]*?<\/button>/.exec(form)?.[0] ?? "")).toBe("Enter lobby");
    // Outside the form: focusing or hovering it never warms the room chunk, and Enter in the nickname still joins.
    expect(form).not.toContain('data-testid="find-room"');
    const find = /<button[^>]*data-testid="find-room"[^>]*>[\s\S]*?<\/button>/.exec(served)?.[0] ?? "";
    expect(attrs(find)["type"]).toBe("button");
    expect(text(find)).toContain("Find or create a room");
    expect(served.indexOf('data-testid="find-room"')).toBeGreaterThan(served.indexOf('data-testid="join-button"'));
  });

  test("the avatar radios keep their ids and order and name each avatar in text", () => {
    const radios = [...served.matchAll(/<button[^>]*data-testid="avatar-option"[^>]*>[\s\S]*?<\/button>/g)].map((m) => m[0]);
    expect(radios.map((r) => attrs(r)["data-avatar"])).toEqual(["0", "1", "2", "3"]);
    expect(radios.map((r) => attrs(r)["role"])).toEqual(["radio", "radio", "radio", "radio"]);
    expect(radios.map((r) => text(r))).toEqual([...AVATARS]);
    expect(radios.map((r) => attrs(r)["aria-label"])).toEqual([...AVATARS]);
  });

  test("the directory screen's head is in the page: Find a room, Edit profile, and quick links to the lists", () => {
    const home = /<section[^>]*id="home-root"[^>]*>([\s\S]*?)<\/section>/.exec(served)?.[1] ?? "";
    expect(home).toMatch(/<h1[^>]*id="directory-title"[^>]*tabindex="-1"[^>]*>Find a room<\/h1>/);
    expect(home).toMatch(/<button[^>]*type="button"[^>]*data-testid="edit-profile"[^>]*>Edit profile<\/button>/);
    expect(home).toMatch(/<a href="#open-rooms"[^>]*>Open rooms/);
    expect(home).toMatch(/<a href="#create-room-title"[^>]*>Make a room/);
    expect(home).toContain('id="directory"');
  });

  test("no remote images and no third-party badges anywhere on the page", () => {
    for (const m of served.matchAll(/<img\s[^>]*>/g)) expect(attrs(m[0])["src"] ?? "").toStartWith("/");
    expect(served).not.toMatch(/(?:src|href|srcset)="[^"]*(?:badge|play\.google|mozilla\.net|gstatic)/i);
  });
});

describe("install links", () => {
  test("neither store lists the extension yet, so both say coming soon, behind one constant each", () => {
    expect(FIREFOX_LISTING_URL).toBeNull();
    expect(CHROME_LISTING_URL).toBeNull();
    const row = /<p class="install"[^>]*>([\s\S]*?)<\/p>/.exec(served)?.[1] ?? "";
    expect(text(row)).toContain("Firefox: coming soon");
    expect(text(row)).toContain("Chrome: coming soon");
    expect(row).not.toMatch(/<a\s/);
  });

  test("a listing URL turns its entry into an 'Add to …' link that opens the store in a new tab", () => {
    const html = installLinks({ firefox: "https://addons.mozilla.org/firefox/addon/omega-share/", chrome: null });
    const a = /<a\s[^>]*>Add to Firefox<\/a>/.exec(html)?.[0] ?? "";
    expect(attrs(a)["href"]).toBe("https://addons.mozilla.org/firefox/addon/omega-share/");
    expect(attrs(a)["target"]).toBe("_blank");
    expect(attrs(a)["rel"]?.split(" ").sort()).toEqual(["noopener", "noreferrer"]);
    expect(text(html)).toContain("Chrome: coming soon");
    const both = installLinks({ firefox: null, chrome: "https://chromewebstore.google.com/detail/omega-share/abcdefghijklmnopabcdefghijklmnop" });
    expect(both).toMatch(/>Add to Chrome<\/a>/);
    expect(text(both)).toContain("Firefox: coming soon");
  });

  test("a listing URL off the store's own https origin fails the build", () => {
    for (const bad of ["http://addons.mozilla.org/x", "https://evil.example/addon", "javascript:alert(1)", "https://addons.mozilla.org.evil.example/"]) {
      expect(() => installLinks({ firefox: bad, chrome: null })).toThrow();
      expect(() => installLinks({ firefox: null, chrome: bad })).toThrow();
    }
  });

  test("withInstallLinks leaves pages without the slot alone", () => {
    expect(withInstallLinks("<p>no slot</p>", { firefox: null, chrome: null })).toBe("<p>no slot</p>");
  });
});

describe("site footer", () => {
  test("Privacy · Terms · Contact · Licences · Source · Feedback, then the build's short sha", () => {
    const f = footer(served);
    const links = [...f.matchAll(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map((m) => [m[1], m[2]]);
    expect(links).toEqual([
      ["/privacy.html", "Privacy"],
      ["/terms.html", "Terms"],
      ["/contact.html", "Contact"],
      ["/licenses.html", "Licences"],
      [REPO_URL, "Source"],
      [`${REPO_URL}/issues`, "Feedback"],
    ]);
    expect(text(f)).toContain("Original art · CC BY-SA 4.0");
    expect(text(f)).toMatch(/version (?:[0-9a-f]{7}|dev)$/);
    expect(f).not.toContain("%OMEGA_");
  });

  test("buildSha: a configured sha wins, then git's, else 'dev'; only hex survives", () => {
    expect(buildSha("0123456789abcdef", () => "fedcba9")).toBe("0123456");
    expect(buildSha(undefined, () => "fedcba9876\n")).toBe("fedcba9");
    expect(buildSha("", () => "fedcba9")).toBe("fedcba9");
    expect(buildSha("not-a-sha;<b>", () => "fedcba9")).toBe("fedcba9");
    expect(buildSha(undefined, () => undefined)).toBe("dev");
    expect(
      buildSha(undefined, () => {
        throw new Error("no git");
      }),
    ).toBe("dev");
    expect(buildSha(undefined, () => "<script>")).toBe("dev");
  });

  test("withBuildInfo fills every version slot and leaves pages without one alone", () => {
    expect(withBuildInfo("<i>%OMEGA_VERSION%</i>", "abc1234")).toBe("<i>abc1234</i>");
    expect(withBuildInfo("<i>none</i>", "abc1234")).toBe("<i>none</i>");
  });
});

describe("head: description, icons, manifest", () => {
  test("the built page carries them itself (dev server, any static host)", () => {
    expect(count(built, /<meta name="description" content="[^"]{20,}"/g)).toBe(1);
    expect(count(built, /<link rel="icon" href="\/favicon\.ico"/g)).toBe(1);
    expect(count(built, /<link rel="apple-touch-icon" href="\/apple-touch-icon\.png"/g)).toBe(1);
    expect(count(built, /<link rel="manifest" href="\/manifest\.webmanifest"/g)).toBe(1);
  });

  test("served, there is still exactly one of each (the server's own, which may differ per room)", () => {
    expect(count(served, /<meta name="description"/g)).toBe(1);
    expect(count(served, /<link rel="icon"/g)).toBe(1);
    expect(count(served, /<link rel="apple-touch-icon"/g)).toBe(1);
    expect(count(served, /<link rel="manifest"/g)).toBe(1);
    expect(served).toMatch(/<meta property="og:title"/);
  });
});
