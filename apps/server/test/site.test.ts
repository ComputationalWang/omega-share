import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import { DEFAULT_LAYOUT } from "@omega/shared";
import { siteMeta } from "../src/site-meta";
import { openDatabase } from "../src/store/db";
import { RoomStore } from "../src/store/rooms";
import { SITE_ORIGIN, start, type TestServer } from "./helpers";

/** Real 404s, robots.txt, icons and manifest, and the serve-time share card (OME-764, research m9-release-legal §5). */

const PUBLIC_ORIGIN = "https://quiet-otter.ngrok-free.app";
const PUBLIC_HOST = "quiet-otter.ngrok-free.app";
const OWNER = new Uint8Array(32);

let t: TestServer | null = null;
afterEach(async () => {
  await t?.server.stop(true);
  t = null;
});

const get = (path: string, headers: Record<string, string> = {}) => fetch(`${t?.http ?? ""}${path}`, { headers: { host: PUBLIC_HOST, ...headers } });

/** A built site: the shell, the privacy page (the 404 page's look), and a hashed asset. */
function site(): string {
  const dist = join(mkdtempSync(join(tmpdir(), "omega-site-")), "dist");
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(join(dist, "index.html"), '<!doctype html><html><head><meta charset="utf-8" /><title>omega</title></head><body><div id="app"></div></body></html>');
  writeFileSync(
    join(dist, "privacy.html"),
    '<!doctype html><html><head><meta charset="utf-8" /><title>Privacy · omega-share</title><link rel="stylesheet" href="/assets/style-Ab12Cd34.css" /></head>' +
      '<body><main class="privacy"><h1>Privacy</h1><p>We keep nothing.</p></main></body></html>',
  );
  writeFileSync(join(dist, "assets", "style-Ab12Cd34.css"), "main{}");
  return dist;
}

/** The pinned production CSP (boundary.test.ts): every new response carries it unchanged. */
const CSP_PREFIX = "default-src 'self'; script-src 'self' https://www.youtube.com/iframe_api";
function expectSecurityHeaders(res: Response): void {
  expect(res.headers.get("content-security-policy") ?? "").toStartWith(CSP_PREFIX);
  expect(res.headers.get("content-security-policy") ?? "").toContain("require-trusted-types-for 'script'; trusted-types omega-sdk youtube-widget-api");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("cross-origin-opener-policy")).toBe("same-origin");
  expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
}

async function createRoom(title: string, visibility: "public" | "private"): Promise<string> {
  const res = await fetch(`${t?.http ?? ""}/rooms`, {
    method: "POST",
    headers: { origin: SITE_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ title, visibility }),
  });
  expect(res.status).toBe(201);
  const body: unknown = await res.json();
  if (typeof body !== "object" || body === null || !("room" in body)) throw new Error("no room");
  const room: unknown = body.room;
  if (typeof room !== "object" || room === null || !("id" in room) || typeof room.id !== "string") throw new Error("no room id");
  return room.id;
}

const ogTitle = (html: string): string | null => /<meta property="og:title" content="([^"]*)"/.exec(html)?.[1] ?? null;

describe("siteMeta: the share card tags", () => {
  test("the generic card: title, description, absolute 1200×630 image, type and a large Twitter card", () => {
    const html = siteMeta(PUBLIC_ORIGIN, null);
    expect(ogTitle(html)).toBe("omega-share");
    expect(html).toContain('<meta property="og:type" content="website" />');
    expect(html).toContain(`<meta property="og:image" content="${PUBLIC_ORIGIN}/og-image.png" />`);
    expect(html).toContain('<meta property="og:image:width" content="1200" />');
    expect(html).toContain('<meta property="og:image:height" content="630" />');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />');
    expect(html).toMatch(/<meta name="description" content="[^"<>]{20,}" \/>/);
    expect(html).toMatch(/<meta property="og:description" content="[^"<>]{20,}" \/>/);
  });

  test("a room title is wrapped and attribute-escaped: quotes, <, > and &", () => {
    expect(ogTitle(siteMeta(PUBLIC_ORIGIN, `Tom & "Jerry" <b>'s</b>`))).toBe("Tom &amp; &quot;Jerry&quot; &lt;b&gt;&#39;s&lt;/b&gt; · omega-share");
  });

  test("bidi controls and zero-width characters are dropped, and the title is NFKC-normalised", () => {
    expect(ogTitle(siteMeta(PUBLIC_ORIGIN, "Film\u202e club\u200b\u2066\ufeff"))).toBe("Film club · omega-share");
    expect(ogTitle(siteMeta(PUBLIC_ORIGIN, "\uff26ilm night"))).toBe("Film night · omega-share");
    // Nothing left after cleaning: the generic card.
    expect(siteMeta(PUBLIC_ORIGIN, "\u200b\u202e ")).toBe(siteMeta(PUBLIC_ORIGIN, null));
  });

  test("a legacy over-long title is cut to the title limit, and og:title stays within 80 characters", () => {
    const title = ogTitle(siteMeta(PUBLIC_ORIGIN, "a".repeat(200))) ?? "";
    expect(title).toBe(`${"a".repeat(32)} · omega-share`);
    expect(Array.from(title).length).toBeLessThanOrEqual(80);
  });
});

describe("site routes: shell, share card and real 404s", () => {
  test("/ and /r/<valid id> get the shell with the generic card, not cached", async () => {
    t = start({ staticDir: site(), publicOrigin: PUBLIC_ORIGIN });
    for (const path of ["/", "/r/lobby", "/r/lobby/", "/r/no-such-room", "/index.html"]) {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") ?? "").toContain("text/html");
      expect(res.headers.get("cache-control")).toBe("no-cache");
      const html = await res.text();
      expect(html).toContain('<div id="app"></div>');
      expect(ogTitle(html)).toBe("omega-share");
      expect(html).toContain(`content="${PUBLIC_ORIGIN}/og-image.png"`);
      expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
      expectSecurityHeaders(res);
    }
  });

  test("a public room's link shows its title", async () => {
    t = start({ staticDir: site(), publicOrigin: PUBLIC_ORIGIN });
    const id = await createRoom("Film night & co", "public");
    const res = await get(`/r/${id}`);
    expect(res.status).toBe(200);
    expect(ogTitle(await res.text())).toBe("Film night &amp; co · omega-share");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  test("a private room gets the generic card, byte-identical to an unknown id", async () => {
    t = start({ staticDir: site(), publicOrigin: PUBLIC_ORIGIN });
    const id = await createRoom("Secret club", "private");
    const unknown = "x".repeat(id.length);
    const priv = await (await get(`/r/${id}`)).text();
    expect(priv).not.toContain("Secret");
    expect(priv).toBe(await (await get(`/r/${unknown}`)).text());
  });

  test("a taken-down room gets the generic card, byte-identical to an unknown id", async () => {
    t = start({ staticDir: site(), publicOrigin: PUBLIC_ORIGIN });
    const id = await createRoom("Bad room", "public");
    expect(ogTitle(await (await get(`/r/${id}`)).text())).toBe("Bad room · omega-share");
    t.server.reports.takedown(id);
    const gone = await get(`/r/${id}`);
    expect(gone.status).toBe(200);
    const html = await gone.text();
    expect(html).not.toContain("Bad room");
    expect(html).toBe(await (await get(`/r/${"x".repeat(id.length)}`)).text());
  });

  test("a title the lobby hides (blocklist) gets the generic card too", async () => {
    const store = new RoomStore(openDatabase(join(mkdtempSync(join(tmpdir(), "omega-site-db-")), "omega.db")));
    store.createRoom({ id: "film-club", title: "Film club", createdAt: Date.now(), layout: DEFAULT_LAYOUT, visibility: "public", pinned: false, ownerHash: OWNER });
    t = start({ staticDir: site(), publicOrigin: PUBLIC_ORIGIN, store, roomTitleBlocklist: ["film"] });
    expect(ogTitle(await (await get("/r/film-club")).text())).toBe("omega-share");
  });

  test("unknown paths and invalid room ids are 404 with the not-found page, in the privacy page's look", async () => {
    t = start({ staticDir: site(), publicOrigin: PUBLIC_ORIGIN });
    for (const path of ["/nope", "/privacy", "/foo/bar", "/r/", "/r/Bad_Id", "/r/a/b", `/r/${"a".repeat(33)}`, "/missing.html", "/favicon.png", "/r/lobby.png"]) {
      const res = await get(path);
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type") ?? "").toContain("text/html");
      const html = await res.text();
      expect(html).toContain('<link rel="stylesheet" href="/assets/style-Ab12Cd34.css" />');
      expect(html).toContain('<main class="privacy">');
      expect(html).toContain('href="/"');
      expect(html).not.toContain('<div id="app">');
      expect(html).not.toContain("We keep nothing");
      expectSecurityHeaders(res);
    }
  });

  test("the html pages still serve, with the site-wide card", async () => {
    t = start({ staticDir: site(), publicOrigin: PUBLIC_ORIGIN });
    const res = await get("/privacy.html");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("We keep nothing");
    expect(ogTitle(html)).toBe("omega-share");
    expectSecurityHeaders(res);
  });

  test("a page that ships its own description, icon and manifest tags serves one of each: the server's (OME-767)", async () => {
    const dist = site();
    writeFileSync(
      join(dist, "index.html"),
      '<!doctype html><html><head><meta charset="utf-8" /><meta name="description" content="Built-in words." />' +
        '<link rel="icon" href="/favicon.ico" sizes="32x32" /><link rel="apple-touch-icon" href="/apple-touch-icon.png" />' +
        '<link rel="manifest" href="/manifest.webmanifest" /><title>omega</title></head><body><div id="app"></div></body></html>',
    );
    t = start({ staticDir: dist, publicOrigin: PUBLIC_ORIGIN });
    for (const path of ["/", "/r/lobby"]) {
      const html = await (await get(path)).text();
      expect(html).not.toContain("Built-in words.");
      expect(html.match(/<meta name="description"/g)?.length).toBe(1);
      expect(html.match(/<link rel="icon"/g)?.length).toBe(1);
      expect(html.match(/<link rel="apple-touch-icon"/g)?.length).toBe(1);
      expect(html.match(/<link rel="manifest"/g)?.length).toBe(1);
      expect(html).toContain('<div id="app"></div>');
    }
  });

  test("the share card costs under 2 ms p95 on the shell route", async () => {
    t = start({ staticDir: site(), publicOrigin: PUBLIC_ORIGIN });
    const id = await createRoom("Film night", "public");
    const p95 = async (path: string): Promise<number> => {
      const ms: number[] = [];
      for (let i = 0; i < 200; i++) {
        const t0 = performance.now();
        await (await get(path)).text();
        ms.push(performance.now() - t0);
      }
      ms.sort((a, b) => a - b);
      return ms[Math.floor(ms.length * 0.95)] ?? Infinity;
    };
    await p95("/healthz"); // warm-up
    const base = await p95("/healthz");
    expect((await p95(`/r/${id}`)) - base).toBeLessThan(2);
  });
});

describe("robots.txt, icons and the manifest", () => {
  test("robots.txt allows the site, keeps crawlers off the API, has no sitemap and doesn't hide /r/ from noindex", async () => {
    t = start({ staticDir: site(), publicOrigin: PUBLIC_ORIGIN });
    const res = await get("/robots.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/plain");
    const text = await res.text();
    expect(text).toContain("User-agent: *");
    expect(text).toContain("Allow: /");
    expect(text).toContain("Disallow: /rooms");
    expect(text).not.toMatch(/Disallow: \/r\/?$/m);
    expect(text).not.toContain("Sitemap");
    expectSecurityHeaders(res);
  });

  const pngSize = (bytes: Uint8Array): [number, number] => {
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    return [view.getUint32(16), view.getUint32(20)];
  };

  test("favicon, apple-touch-icon and the share image are served with a day's cache", async () => {
    t = start({ staticDir: site(), publicOrigin: PUBLIC_ORIGIN });
    const ico = await get("/favicon.ico");
    expect(ico.status).toBe(200);
    expect(ico.headers.get("content-type") ?? "").toMatch(/image\/(x-icon|vnd\.microsoft\.icon)/);
    expect(ico.headers.get("cache-control")).toBe("public, max-age=86400");
    expectSecurityHeaders(ico);
    const touch = await get("/apple-touch-icon.png");
    expect(touch.headers.get("content-type")).toBe("image/png");
    expect(pngSize(new Uint8Array(await touch.arrayBuffer()))).toEqual([180, 180]);
    const og = await get("/og-image.png");
    expect(og.headers.get("content-type")).toBe("image/png");
    expect(og.headers.get("cache-control")).toBe("public, max-age=86400");
    expect(pngSize(new Uint8Array(await og.arrayBuffer()))).toEqual([1200, 630]);
  });

  test("the manifest names the app, uses the site colours, starts at / standalone, and its icons resolve", async () => {
    t = start({ staticDir: site(), publicOrigin: PUBLIC_ORIGIN });
    const res = await get("/manifest.webmanifest");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("application/manifest+json");
    expect(res.headers.get("cache-control")).toBe("public, max-age=86400");
    expectSecurityHeaders(res);
    const manifest: unknown = await res.json();
    expect(manifest).toMatchObject({
      name: "omega-share",
      short_name: "omega-share",
      start_url: "/",
      display: "standalone",
      theme_color: "#1d1a2b",
      background_color: "#1d1a2b",
    });
    const { icons } = v.parse(
      v.object({ icons: v.array(v.object({ src: v.string(), sizes: v.string(), type: v.literal("image/png"), purpose: v.picklist(["any", "maskable"]) })) }),
      manifest,
    );
    expect(icons.map((i) => `${i.sizes} ${i.purpose}`).sort()).toEqual(["192x192 any", "512x512 any", "512x512 maskable"]);
    for (const icon of icons) {
      const png = await get(icon.src);
      expect(png.status).toBe(200);
      const [w, h] = pngSize(new Uint8Array(await png.arrayBuffer()));
      expect(`${String(w)}x${String(h)}`).toBe(icon.sizes);
    }
  });

  test("the served icons and share image are the judged M9 art from assets/site, byte for byte (OME-762, OME-785)", async () => {
    t = start({ staticDir: site(), publicOrigin: PUBLIC_ORIGIN });
    const art = join(import.meta.dir, "../../../assets/site");
    const served: [string, string][] = [
      ["/favicon.ico", "favicon.ico"],
      ["/apple-touch-icon.png", "apple-touch-icon.png"],
      ["/icon-192.png", "icon-192.png"],
      ["/icon-512.png", "icon-512.png"],
      ["/icon-maskable-512.png", "icon-maskable-512.png"],
      ["/og-image.png", "og-card.png"],
    ];
    for (const [path, file] of served) {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("public, max-age=86400");
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(await Bun.file(join(art, file)).bytes());
    }
  });
});
