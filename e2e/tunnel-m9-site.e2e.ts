// M9 site surface on the REAL built site served by the REAL server process (OME-770, M9 Q1): the legal pages, real 404s,
// the share card crawlers read (Open Graph), room-title safety (S1) and header parity. Regular e2e goes through Vite dev
// and never sees the server's headers or HTML, so this spec lives in the e2e-tunnel project: vite build into a temp dir,
// `bun apps/server/src/index.ts` with STATIC_DIR, a file DB seeded before start, behind the TLS proxy, and plain Chromium.
// Unit coverage (apps/server/test/site.test.ts) is not repeated: this proves the same promises end to end.
//
// Why titles are seeded, not posted: POST /rooms spends a per-key bucket and a global one (harness-gotchas), so a fuzz
// of dozens of titles can't go through it. Titles the schema accepts are seeded with the store (same RoomTitleSchema
// parse as POST); titles it refuses are posted for real (a refusal costs no global token) and must answer 400.
import { spawnSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import type { Page } from "@playwright/test";
import * as v from "valibot";
import { RoomTitleSchema } from "@omega/shared";
import { ROOT } from "./support/apps";
import { PUBLIC_HOST } from "./fixtures/proxy";
import { PUBLIC_ORIGIN, SITE_PORTS, expect, laneTest, tunnelRequest, tunnelRequestBytes, type RawBytesResponse } from "./tunnel-support";

// ---- Rooms ----

const PUBLIC_ID = "site-public";
const PUBLIC_TITLE = "Tom & 'Jerry'";
const PRIVATE_ID = "site-private";
const PRIVATE_TITLE = "Secret club";
const TAKEN_DOWN_TITLE = "Doomed room";
/** A valid room id nobody created. */
const UNKNOWN_ID = "site-unknown-room";
/** One taken-down room per repeat (`--repeat-each` shares the worker's server, and a room can only be taken down once). */
const TAKEN_DOWN_COPIES = 6;
const takenDownId = (n: number): string => `site-gone-${String(n)}`;

/** A fuzz case the room-title schema accepts: what goes in, and the title the server must hold (NFKC, per RoomTitleSchema). */
interface Accepted {
  readonly label: string;
  readonly input: string;
  /** The decoded `og:title` a crawler's HTML parser must see. */
  readonly card: string;
}

const ACCEPTED: readonly Accepted[] = [
  { label: "ampersand and apostrophes", input: "Tom & 'Jerry'", card: "Tom & 'Jerry' · omega-share" },
  { label: "a lone ampersand", input: "&", card: "& · omega-share" },
  { label: "an apostrophe in a word", input: "a'b", card: "a'b · omega-share" },
  { label: "an ampersand in a word", input: "a&b", card: "a&b · omega-share" },
  // Entity look-alikes: a single HTML decode must give back the typed text, never `<` or `&`.
  { label: "an unterminated entity &lt", input: "&lt", card: "&lt · omega-share" },
  { label: "an unterminated entity &amp", input: "&amp", card: "&amp · omega-share" },
  { label: "entities without semicolons", input: "&lt,b&gt,", card: "&lt,b&gt, · omega-share" },
  { label: "a javascript: url", input: "javascript:alert(1)", card: "javascript:alert(1) · omega-share" },
  { label: "2-byte unicode", input: "Café Münch", card: "Café Münch · omega-share" },
  { label: "4-byte unicode (NFKC folds the math letter)", input: "𝒜 Film", card: "A Film · omega-share" },
  { label: "4-byte CJK", input: "𠮷野家", card: "𠮷野家 · omega-share" },
  { label: "fullwidth letters (NFKC)", input: "Ｆilm night", card: "Film night · omega-share" },
  { label: "a ligature (NFKC)", input: "ﬁlm", card: "film · omega-share" },
  { label: "the longest title, 32 letters", input: "a".repeat(32), card: `${"a".repeat(32)} · omega-share` },
  { label: "the allowed punctuation", input: "It's (fun) #1: yes+no!?", card: "It's (fun) #1: yes+no!? · omega-share" },
];

/** Hostile titles the schema must refuse: no room, so no card, and a 400 for the creator. */
const REJECTED: readonly [label: string, title: string][] = [
  ["attribute breakout and script tag", '"><script>alert(1)</script>'],
  ["single-quote event handler", "' onmouseover='x"],
  ["closing title and svg onload", "</title><svg onload=x>"],
  ["encoded entities", "&amp;&lt;"],
  ["a named entity", "Tom &amp; Jerry"],
  ["a numeric entity", "&#60;&#x3c;"],
  ["an HTML comment opener", "<!--"],
  ["a CDATA closer", "]]>"],
  ["backticks", "`tick`"],
  ["a right-to-left override", "Film‮ club"],
  ["a zero-width space", "Fi​lm"],
  ["a NUL byte", "a\u0000b"],
  ["an emoji", "Movie 🎬"],
  ["a template expression {{7*7}}", "{{7*7}}"],
  ["a template literal ${x}", "${x}"],
  ["a newline", "a\nb"],
  ["a CRLF header-injection attempt", "a\r\nSet-Cookie: x=1"],
  ["a lone CR", "a\rb"],
  ["a very long string", "a".repeat(5000)],
  ["33 letters (one over the limit)", "a".repeat(33)],
  ["a backslash", "a\\b"],
  ["percent-encoded markup", "%3Cscript%3E"],
  ["a bare tag", "<b>"],
];

const fuzzId = (i: number): string => `site-fz-${String(i)}`;

interface SeedInput {
  readonly rooms: readonly { readonly id: string; readonly title: string; readonly visibility: "public" | "private" }[];
}

function seedInput(): SeedInput {
  return {
    rooms: [
      { id: PUBLIC_ID, title: PUBLIC_TITLE, visibility: "public" },
      { id: PRIVATE_ID, title: PRIVATE_TITLE, visibility: "private" },
      ...Array.from({ length: TAKEN_DOWN_COPIES }, (_, n) => ({ id: takenDownId(n), title: TAKEN_DOWN_TITLE, visibility: "public" as const })),
      ...ACCEPTED.map((a, i) => ({ id: fuzzId(i), title: a.input, visibility: "public" as const })),
    ],
  };
}

/** Runs under bun (bun:sqlite), as `e2e/fixtures/seed-rooms.ts` does: through the store's own schema parse (a row that fails it stops the server at boot, so no hostile row can exist). */
const SEED_SCRIPT = `
import { DEFAULT_LAYOUT } from "@omega/shared";
import { openDatabase } from "${ROOT}/apps/server/src/store/db";
import { RoomStore } from "${ROOT}/apps/server/src/store/rooms";
import { hashSecret } from "${ROOT}/apps/server/src/secrets";
const input = JSON.parse(await Bun.stdin.text());
const db = openDatabase(process.env.OMEGA_SEED_DB);
const store = new RoomStore(db);
for (const r of input.rooms) {
  store.createRoom({ id: r.id, title: r.title, createdAt: Date.now(), layout: DEFAULT_LAYOUT, visibility: r.visibility, pinned: false, ownerHash: hashSecret("owner-" + r.id), inviteHash: r.visibility === "private" ? hashSecret("invite-" + r.id) : null });
}
db.close();
`;

function seedDb(dbPath: string): void {
  const r = spawnSync("bun", ["-e", SEED_SCRIPT], { cwd: ROOT, input: JSON.stringify(seedInput()), env: { ...process.env, OMEGA_SEED_DB: dbPath }, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`seeding ${dbPath} failed:\n${r.stdout}\n${r.stderr}`);
}

const test = laneTest(SITE_PORTS, { seedDb });

// ---- Clients ----

const FACEBOOK = "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)";
const TWITTER = "Twitterbot/1.0";
const CHROME = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

/** A distinct synthetic client per request: no two share the per-client HTTP bucket or the room-creation bucket. */
let nextClient = 1;
const freshClient = (): string => `203.0.113.${String(nextClient++ % 250)}`;

const get = (path: string, userAgent: string = FACEBOOK): Promise<RawBytesResponse> =>
  tunnelRequestBytes({ port: SITE_PORTS.proxy, path, headers: { "x-fixture-client": freshClient(), "user-agent": userAgent } });

const text = (r: RawBytesResponse): string => r.body.toString("utf8");

const CreatedSchema = v.object({ ok: v.literal(true), room: v.object({ id: v.string() }) });

const postRoom = (title: string, visibility: "public" | "private") =>
  tunnelRequest({
    method: "POST",
    port: SITE_PORTS.proxy,
    path: "/rooms",
    headers: { "content-type": "application/json", origin: PUBLIC_ORIGIN, "x-fixture-client": freshClient() },
    body: JSON.stringify({ title, visibility }),
  });

/** The operator's takedown over the admin socket: the real mechanism (`rooms takedown <id>` in the CLI). */
function takeDown(socketPath: string, id: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath, path: `/rooms/${id}/takedown`, method: "POST" }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (body += c));
      res.on("end", () => {
        if (res.statusCode !== 200) reject(new Error(`takedown ${id}: ${String(res.statusCode)} ${body}`));
        else resolve(JSON.parse(body) as unknown);
      });
    });
    req.on("error", reject);
    req.end();
  });
}

// ---- HTML parsing (a real parser, scripts never run) ----

interface Parsed {
  /** Every `og:title` content, entity-decoded by the parser. */
  readonly ogTitles: readonly string[];
  readonly twitterTitles: readonly string[];
  /** One entry per `<head>` child: tag and sorted attribute names, so an injected tag or attribute shows. */
  readonly head: readonly string[];
  readonly elements: number;
  readonly scripts: number;
  readonly docTitle: string;
}

function parseHtml(html: string): Parsed {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const content = (sel: string): string[] => Array.from(doc.querySelectorAll(sel)).map((m) => m.getAttribute("content") ?? "");
  return {
    ogTitles: content('meta[property="og:title"]'),
    twitterTitles: content('meta[name="twitter:title"]'),
    head: Array.from(doc.head.children).map((e) => `${e.tagName.toLowerCase()}[${e.getAttributeNames().sort().join(",")}]`),
    elements: doc.querySelectorAll("*").length,
    scripts: doc.querySelectorAll("script").length,
    docTitle: doc.title,
  };
}

/** Parsing happens in a blank page of a real Chromium: DOMParser creates an inert document, so nothing loads or runs. */
async function parseIn(page: Page, html: string): Promise<Parsed> {
  return page.evaluate(parseHtml, html);
}

/** The page with its `og:title` value blanked: everything else in the response must be the generic card, byte for byte. */
const withoutOgTitle = (html: string): string => html.replace(/(<meta property="og:title" content=")[^"]*(")/, "$1$2");

// ---- Headers ----

const SECURITY_HEADERS = [
  "content-security-policy",
  "strict-transport-security",
  "x-content-type-options",
  "referrer-policy",
  "permissions-policy",
  "cross-origin-opener-policy",
  "cross-origin-resource-policy",
  "cross-origin-embedder-policy",
  "x-frame-options",
] as const;

const securityOf = (r: RawBytesResponse): Record<string, string | undefined> => Object.fromEntries(SECURITY_HEADERS.map((h) => [h, r.headers[h]]));

/** Every header but `date`, sorted: what a client could use to tell two responses apart (besides the clock). */
const headerSet = (r: RawBytesResponse): [string, string][] =>
  Object.entries(r.headers)
    .filter(([name]) => name !== "date")
    .sort(([a], [b]) => a.localeCompare(b));

const LEGAL = ["privacy", "terms", "contact", "licenses"] as const;
const legalPath = (name: string): string => `/${name}.html`;

// The taken-down room: the real operator takedown, over the admin socket, before any crawler test. One room per repeat.
test.beforeAll(async ({ lane }, testInfo) => {
  if (lane.adminSocket === null) throw new Error("lane has no admin socket");
  const id = takenDownId(testInfo.repeatEachIndex);
  const before = text(await get(`/r/${id}`));
  expect(before, "the room is public and previewed until it is taken down").toContain(`content="${TAKEN_DOWN_TITLE} · omega-share"`);
  expect(await takeDown(lane.adminSocket, id)).toMatchObject({ takenDown: id });
});

test.describe("legal pages", () => {
  for (const name of LEGAL) {
    test(`${legalPath(name)} answers 200 text/html with the full security headers`, async ({}) => {
      const res = await get(legalPath(name), CHROME);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(text(res)).toContain("<h1>");
      expect(res.headers["content-security-policy"]).toContain("default-src 'self'");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
    });

    test(`${legalPath(name)} loads in Chromium under the server's real CSP with zero violations`, async ({ newTunnelContext, csp }) => {
      const page = await (await newTunnelContext()).newPage();
      const res = await page.goto(`${PUBLIC_ORIGIN}${legalPath(name)}`, { waitUntil: "load" });
      expect(res?.status()).toBe(200);
      // The header is what the browser enforced (the meta CSP in the HTML only intersects with it).
      expect(await res?.headerValue("content-security-policy")).toContain("require-trusted-types-for 'script'");
      await expect(page.locator("main h1")).toBeVisible();
      await page.waitForLoadState("networkidle");
      expect(csp.enforced).toEqual([]);
      expect(csp.console).toEqual([]);
    });
  }

  test("the clean URLs without .html are not pages (404), so every link must use the .html paths", async () => {
    for (const name of LEGAL) expect((await get(`/${name}`)).status).toBe(404);
  });

  test("the landing page footer links to every legal page", async ({ newTunnelContext, csp }) => {
    const page = await (await newTunnelContext()).newPage();
    const res = await page.goto(`${PUBLIC_ORIGIN}/`, { waitUntil: "load" });
    expect(res?.status()).toBe(200);
    for (const name of LEGAL) {
      const link = page.locator(`footer.site-footer [data-testid="${name}-link"]`);
      await expect(link).toHaveAttribute("href", legalPath(name));
    }
    // The footer's off-site links carry the real source URL, not the build placeholder.
    for (const id of ["source-link", "feedback-link"]) {
      const href = await page.locator(`footer.site-footer [data-testid="${id}"]`).getAttribute("href");
      expect(href).toMatch(/^https:\/\/[^%\s]+$/);
    }
    expect(csp.enforced).toEqual([]);
  });

  test("every legal page links to the other three, and every internal link on every page resolves 200 in Chromium", async ({ newTunnelContext, csp }) => {
    const page = await (await newTunnelContext()).newPage();
    for (const from of LEGAL) {
      await page.goto(`${PUBLIC_ORIGIN}${legalPath(from)}`, { waitUntil: "load" });
      const hrefs = await page.locator("a[href]").evaluateAll((as) => as.map((a) => a.getAttribute("href") ?? ""));
      for (const to of LEGAL.filter((n) => n !== from)) {
        expect(hrefs.some((h) => h.split("#")[0] === legalPath(to)), `${from} links to ${to}`).toBe(true);
      }
      const internal = [...new Set(hrefs.filter((h) => h.startsWith("/")))];
      expect(internal.length).toBeGreaterThanOrEqual(3);
      for (const href of internal) {
        const target = new URL(href, PUBLIC_ORIGIN);
        const res = await page.goto(`${target.origin}${target.pathname}${target.search}`, { waitUntil: "load" });
        expect(res?.status(), `${from} -> ${href}`).toBe(200);
        if (target.hash !== "") expect(await page.locator(`[id="${decodeURIComponent(target.hash.slice(1))}"]`).count(), `${href} anchor exists`).toBe(1);
      }
      // No placeholder left in any href the build should have filled in.
      for (const h of hrefs) expect(h, `${from} has an unfilled build placeholder`).not.toContain("%OMEGA_");
    }
    expect(csp.enforced).toEqual([]);
  });

  for (const name of LEGAL) {
    // product bug: only privacy.html has a link back to "/"; terms, contact and licenses have only the footer (no home link).
    const status = name === "privacy" ? test : test.fail;
    status(`${legalPath(name)} links back home`, async ({ newTunnelContext }) => {
      const page = await (await newTunnelContext()).newPage();
      await page.goto(`${PUBLIC_ORIGIN}${legalPath(name)}`, { waitUntil: "load" });
      const home = page.locator('a[href="/"]');
      await expect(home.first()).toBeVisible();
      await home.first().click();
      await expect(page).toHaveURL(`${PUBLIC_ORIGIN}/`);
    });
  }
});

test.describe("real 404s", () => {
  for (const path of ["/nope", "/r/not-a-valid-id!", "/foo/bar", "/r/Bad_Id"]) {
    test(`${path} is a 404 with the not-found page, to a raw client and to Chromium`, async ({ newTunnelContext, csp }) => {
      const raw = await get(path, CHROME);
      expect(raw.status).toBe(404);
      expect(raw.headers["content-type"]).toContain("text/html");
      const html = text(raw);
      expect(html).toContain("<h1>Page not found</h1>");
      expect(html).not.toContain('id="app"');
      expect(html).not.toContain("og:title");

      const page = await (await newTunnelContext()).newPage();
      const res = await page.goto(`${PUBLIC_ORIGIN}${path}`, { waitUntil: "load" });
      expect(res?.status()).toBe(404);
      await expect(page.getByRole("heading", { level: 1, name: "Page not found" })).toBeVisible();
      await expect(page.getByRole("link", { name: "Go to omega-share" })).toHaveAttribute("href", "/");
      await expect(page).toHaveTitle("Page not found · omega-share");
      await page.waitForLoadState("networkidle");
      expect(csp.enforced).toEqual([]);
      expect(csp.console).toEqual([]);
    });
  }

  test("a valid-format room id nobody created answers the 200 shell with the generic card, same bytes as the landing page", async () => {
    const home = await get("/");
    expect(home.status).toBe(200);
    for (const path of [`/r/${UNKNOWN_ID}`, `/r/${UNKNOWN_ID}/`]) {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(text(res)).toContain('<main id="app">');
      expect(res.body.equals(home.body)).toBe(true);
    }
  });
});

test.describe("share card for crawlers", () => {
  test("a public room's link carries its title, HTML-escaped, in og:title for Facebook and Twitter crawlers", async ({ newTunnelContext }) => {
    const page = await (await newTunnelContext()).newPage();
    for (const ua of [FACEBOOK, TWITTER]) {
      const res = await get(`/r/${PUBLIC_ID}`, ua);
      expect(res.status).toBe(200);
      const html = text(res);
      // Escaped on the wire: the quote characters and & can't end the attribute or start an entity.
      expect(html).toContain('<meta property="og:title" content="Tom &amp; &#39;Jerry&#39; · omega-share" />');
      expect(html).not.toContain("Tom & 'Jerry'");
      const parsed = await parseIn(page, html);
      expect(parsed.ogTitles).toEqual(["Tom & 'Jerry' · omega-share"]);
      expect(parsed.twitterTitles.every((t) => t === "Tom & 'Jerry' · omega-share")).toBe(true);
      expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />');
      expect(html).toContain(`<meta property="og:image" content="${PUBLIC_ORIGIN}/og-image.png" />`);
    }
  });

  test("the card works without JavaScript: the title is in the first response, not rendered by the client", async () => {
    const res = await get(`/r/${PUBLIC_ID}`);
    expect(text(res)).toContain("og:title");
    expect(text(res)).toContain("Jerry");
  });

  test("private, taken-down and unknown-id rooms get the same bytes, and they are the generic card", async ({}, testInfo) => {
    const gone = takenDownId(testInfo.repeatEachIndex);
    const [priv, down, unknown, home] = [await get(`/r/${PRIVATE_ID}`), await get(`/r/${gone}`), await get(`/r/${UNKNOWN_ID}`), await get("/")];
    expect(priv.status).toBe(200);
    expect(down.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(priv.body.equals(unknown.body)).toBe(true);
    expect(down.body.equals(unknown.body)).toBe(true);
    expect(priv.body.equals(home.body)).toBe(true);
    for (const body of [priv, down]) {
      expect(text(body)).not.toContain(PRIVATE_TITLE);
      expect(text(body)).not.toContain(TAKEN_DOWN_TITLE);
    }
    expect(text(unknown)).toContain('<meta property="og:title" content="omega-share" />');
  });

  test("a room created for real over POST /rooms is previewed (public) or hidden (private) the same way", async ({ newTunnelContext }) => {
    const page = await (await newTunnelContext()).newPage();
    const pub = await postRoom("Real & Public", "public");
    expect(pub.status).toBe(201);
    const pubId = v.parse(CreatedSchema, JSON.parse(pub.body)).room.id;
    expect((await parseIn(page, text(await get(`/r/${pubId}`)))).ogTitles).toEqual(["Real & Public · omega-share"]);

    const priv = await postRoom("Real Secret", "private");
    expect(priv.status).toBe(201);
    const privId = v.parse(CreatedSchema, JSON.parse(priv.body)).room.id;
    const privBody = await get(`/r/${privId}`);
    expect(text(privBody)).not.toContain("Real Secret");
    expect(privBody.body.equals((await get(`/r/${UNKNOWN_ID}`)).body)).toBe(true);
  });

  test("robots.txt is text/plain and allows the site", async () => {
    const res = await get("/robots.txt");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(text(res)).toContain("User-agent: *");
  });

  test("the manifest is application/manifest+json and its icons resolve as PNG images", async () => {
    const res = await get("/manifest.webmanifest");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/manifest+json");
    const manifest = v.parse(v.object({ name: v.string(), icons: v.pipe(v.array(v.object({ src: v.string(), type: v.string() })), v.minLength(1)) }), JSON.parse(text(res)));
    expect(manifest.name).toBe("omega-share");
    for (const icon of manifest.icons) {
      const png = await get(icon.src);
      expect(png.status, icon.src).toBe(200);
      expect(png.headers["content-type"]).toBe("image/png");
      expect(icon.type).toBe("image/png");
      expect(png.body.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    }
  });

  test("favicon, apple-touch-icon and the og image are served as real images of the right type", async () => {
    const ico = await get("/favicon.ico");
    expect(ico.status).toBe(200);
    expect(ico.headers["content-type"]).toMatch(/^image\/(x-icon|vnd\.microsoft\.icon)$/);
    expect(ico.body.subarray(0, 4).toString("hex")).toBe("00000100");
    for (const path of ["/apple-touch-icon.png", "/og-image.png"]) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      expect(res.headers["content-type"], path).toBe("image/png");
      expect(res.body.subarray(0, 8).toString("hex"), path).toBe("89504e470d0a1a0a");
    }
  });

  test("every icon, manifest and image URL the shell's head names resolves with an image or manifest type", async ({ newTunnelContext }) => {
    const page = await (await newTunnelContext()).newPage();
    const html = text(await get("/"));
    const urls = await page.evaluate((h) => {
      const doc = new DOMParser().parseFromString(h, "text/html");
      return [
        ...Array.from(doc.querySelectorAll("link[rel~=icon], link[rel=apple-touch-icon], link[rel=manifest]")).map((l) => l.getAttribute("href") ?? ""),
        doc.querySelector('meta[property="og:image"]')?.getAttribute("content") ?? "",
      ];
    }, html);
    expect(urls).toHaveLength(4);
    for (const url of urls) {
      const res = await get(new URL(url, PUBLIC_ORIGIN).pathname);
      expect(res.status, url).toBe(200);
      expect(res.headers["content-type"], url).toMatch(/^(image\/|application\/manifest\+json)/);
    }
    expect(urls.some((u) => u.startsWith(`${PUBLIC_ORIGIN}/`))).toBe(true);
  });
});

test.describe("room-title safety on the share card (S1)", () => {
  /** The generic card, parsed once: what every hostile title's page must be structurally identical to. */
  async function generic(page: Page): Promise<{ html: string; parsed: Parsed }> {
    const html = text(await get("/"));
    return { html, parsed: await parseIn(page, html) };
  }

  test("every title the schema accepts renders as exactly one og:title that decodes to the normalised title, and nothing else changes", async ({ newTunnelContext }) => {
    const page = await (await newTunnelContext()).newPage();
    const base = await generic(page);
    expect(base.parsed.ogTitles).toEqual(["omega-share"]);
    for (const [i, a] of ACCEPTED.entries()) {
      // The schema (independent of the server's card code) agrees this title is a valid one.
      expect(v.safeParse(RoomTitleSchema, a.input).success, a.label).toBe(true);
      const res = await get(`/r/${fuzzId(i)}`);
      expect(res.status, a.label).toBe(200);
      const html = text(res);
      const parsed = await parseIn(page, html);
      expect(parsed.ogTitles, a.label).toEqual([a.card]);
      // No extra or missing tag or attribute in the head, no extra element anywhere, no extra script.
      expect(parsed.head, a.label).toEqual(base.parsed.head);
      expect(parsed.elements, a.label).toBe(base.parsed.elements);
      expect(parsed.scripts, a.label).toBe(base.parsed.scripts);
      expect(html.split("<script").length, `${a.label}: raw <script count`).toBe(base.html.split("<script").length);
      expect(parsed.docTitle, a.label).toBe(base.parsed.docTitle);
      // Byte for byte the generic page apart from the og:title value.
      expect(withoutOgTitle(html), a.label).toBe(withoutOgTitle(base.html));
      // The only `"` and `<` in the attribute value's raw form are escapes.
      const raw = /<meta property="og:title" content="([^"]*)" \/>/.exec(html)?.[1] ?? "";
      expect(raw, a.label).not.toMatch(/[<>"']/);
      expect(Array.from(parsed.ogTitles[0] ?? "").length, a.label).toBeLessThanOrEqual(80);
    }
  });

  test("an ampersand, apostrophes and entity look-alikes are escaped once: the parsed text is what was typed", async ({ newTunnelContext }) => {
    const page = await (await newTunnelContext()).newPage();
    const html = text(await get(`/r/${fuzzId(ACCEPTED.findIndex((a) => a.input === "&amp"))}`));
    expect(html).toContain('content="&amp;amp · omega-share"');
    expect((await parseIn(page, html)).ogTitles).toEqual(["&amp · omega-share"]);
  });

  for (const [label, title] of REJECTED) {
    test(`the server refuses a room titled ${label} (4xx), and no room or card appears`, async () => {
      const res = await postRoom(title, "public");
      // 400 for a bad title; 413 when the body is over the size cap before the title is even read.
      expect([400, 413]).toContain(res.status);
      expect(res.headers["set-cookie"]).toBeUndefined();
      expect(Object.keys(res.headers).some((h) => h.startsWith("x-") && h !== "x-content-type-options" && h !== "x-robots-tag")).toBe(false);
      expect(res.body).not.toContain("Set-Cookie");
    });
  }

  test("a title of 32 letters is the longest the card shows, and og:title stays within 80 characters", async ({ newTunnelContext }) => {
    const page = await (await newTunnelContext()).newPage();
    const i = ACCEPTED.findIndex((a) => a.input.length === 32);
    const parsed = await parseIn(page, text(await get(`/r/${fuzzId(i)}`)));
    expect(parsed.ogTitles).toEqual([`${"a".repeat(32)} · omega-share`]);
  });
});

test.describe("header parity", () => {
  test("a taken-down room's link answers like an unknown id from the first request after the takedown", async ({}, testInfo) => {
    const id = takenDownId(testInfo.repeatEachIndex);
    const after = await get(`/r/${id}`);
    expect(text(after)).not.toContain(TAKEN_DOWN_TITLE);
    expect(after.body.equals((await get(`/r/${UNKNOWN_ID}`)).body)).toBe(true);
  });

  test("private, taken-down and unknown-id rooms have identical header sets and values, and equal content-length", async ({}, testInfo) => {
    const priv = await get(`/r/${PRIVATE_ID}`);
    const down = await get(`/r/${takenDownId(testInfo.repeatEachIndex)}`);
    const unknown = await get(`/r/${UNKNOWN_ID}`);
    expect(headerSet(priv)).toEqual(headerSet(unknown));
    expect(headerSet(down)).toEqual(headerSet(unknown));
    // Order and case too, as the server sent them (a different middleware path could reorder headers).
    const names = (r: RawBytesResponse): string[] => r.rawHeaders.filter((_, i) => i % 2 === 0).filter((n) => n.toLowerCase() !== "date");
    expect(names(priv)).toEqual(names(unknown));
    expect(names(down)).toEqual(names(unknown));
    expect(priv.headers["content-length"] ?? String(priv.body.length)).toBe(unknown.headers["content-length"] ?? String(unknown.body.length));
    expect(priv.status).toBe(unknown.status);
    expect(down.status).toBe(unknown.status);
  });

  test("a public room's link differs from the generic ones only where the title is shown (security headers equal)", async () => {
    const pub = await get(`/r/${PUBLIC_ID}`);
    const unknown = await get(`/r/${UNKNOWN_ID}`);
    expect(securityOf(pub)).toEqual(securityOf(unknown));
    expect(pub.headers["cache-control"]).toBe(unknown.headers["cache-control"]);
    expect(pub.headers["content-type"]).toBe(unknown.headers["content-type"]);
  });

  test("security headers are present and the same on the landing page, rooms, legal pages and 404s", async () => {
    const reference = securityOf(await get("/"));
    expect(reference["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(reference["content-security-policy"]).toContain("require-trusted-types-for 'script'");
    expect(reference["strict-transport-security"]).toBe("max-age=31536000");
    expect(reference["x-content-type-options"]).toBe("nosniff");
    expect(reference["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(reference["permissions-policy"]).toContain("camera=()");
    expect(reference["cross-origin-opener-policy"]).toBe("same-origin");
    expect(reference["cross-origin-resource-policy"]).toBe("same-origin");
    // No COEP (it would block the provider iframes) and no X-Frame-Options: frame-ancestors is the control.
    expect(reference["cross-origin-embedder-policy"]).toBeUndefined();
    const paths = [`/r/${PUBLIC_ID}`, `/r/${PRIVATE_ID}`, `/r/${UNKNOWN_ID}`, ...LEGAL.map(legalPath), "/nope", "/foo/bar", "/r/not-a-valid-id!", "/robots.txt", "/manifest.webmanifest", "/favicon.ico", "/healthz"];
    for (const path of paths) {
      const res = await get(path);
      expect(securityOf(res), path).toEqual(reference);
    }
  });

  test("404 and 200 pages differ only in what they must: status, body, length; never in cache policy or content type", async () => {
    const notFound = await get("/nope");
    const unknownRoom = await get(`/r/${UNKNOWN_ID}`);
    expect(notFound.status).toBe(404);
    expect(unknownRoom.status).toBe(200);
    expect(notFound.headers["cache-control"]).toBe(unknownRoom.headers["cache-control"]);
    expect(notFound.headers["content-type"]).toBe(unknownRoom.headers["content-type"]);
    expect(securityOf(notFound)).toEqual(securityOf(unknownRoom));
  });

  test("a crawler and a browser user agent get the same bytes and headers (no cloaking on what a preview could leak)", async () => {
    const crawler = await get(`/r/${PRIVATE_ID}`, FACEBOOK);
    const browser = await get(`/r/${PRIVATE_ID}`, CHROME);
    expect(crawler.body.equals(browser.body)).toBe(true);
    expect(headerSet(crawler)).toEqual(headerSet(browser));
  });

  test("the public host is the one the card names (the og:image URL is on it)", async () => {
    expect(text(await get("/"))).toContain(`content="https://${PUBLIC_HOST}/og-image.png"`);
  });
});
