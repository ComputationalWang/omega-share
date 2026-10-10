import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Context, Hono } from "hono";
import { serveStatic } from "hono/serve-static";
import * as v from "valibot";
import { RoomIdSchema } from "@omega/shared";
import { siteMeta, withMeta } from "./site-meta";

const IMMUTABLE = "public, max-age=31536000, immutable";
/** Fixed names (icons, manifest, robots.txt) can't be immutable: a day, so a new icon shows up soon enough. */
const DAY = "public, max-age=86400";
/** The server's own site files (`apps/server/public`, README there), served at the root by name only. */
const PUBLIC_DIR = join(import.meta.dir, "..", "public");
const PUBLIC_FILES = ["favicon.ico", "apple-touch-icon.png", "icon-192.png", "icon-512.png", "icon-maskable-512.png", "og-image.png", "manifest.webmanifest", "robots.txt"];
/** `/r/<id>` with an optional trailing slash, as `roomIdInPath` in the web app reads it. */
const ROOM_ROUTE = /^\/r\/([^/]+)\/?$/;
const NOT_FOUND_TITLE = "<title>Page not found · omega-share</title>";
const NOT_FOUND_MAIN = '<main class="privacy"><h1>Page not found</h1><p>There is nothing at this address.</p><p><a href="/">Go to omega-share</a></p></main>';
/** Without a built `privacy.html` to borrow its look from. */
const BARE_NOT_FOUND = `<!doctype html><html lang="en"><head><meta charset="utf-8" />${NOT_FOUND_TITLE}</head><body>${NOT_FOUND_MAIN}</body></html>`;

export interface SiteOptions {
  /** Absolute origin for the share card's image URL (PUBLIC_ORIGIN, else SITE_ORIGIN). */
  origin: string;
  /** A room's title if its link may show it (public, listable, not taken down), else null. */
  previewTitle: (id: string) => string | null;
}

const readText = async (path: string): Promise<string | null> => {
  const file = Bun.file(path);
  return (await file.exists()) ? file.text() : null;
};

/** Hono's runtime-neutral static middleware over `Bun.file` (what `hono/bun` did before its deprecation). */
const files = (root: string, path?: string, cacheControl?: string) =>
  serveStatic({
    root,
    ...(path === undefined ? {} : { path }),
    join,
    getContent: async (file) => {
      const blob = Bun.file(file);
      return (await blob.exists()) ? blob : null;
    },
    isDir: async (file) => {
      try {
        return (await stat(file)).isDirectory();
      } catch {
        return false;
      }
    },
    ...(cacheControl === undefined
      ? {}
      : {
          onFound: (_file, c) => {
            c.header("cache-control", cacheControl);
          },
        }),
  });

/**
 * Serves the built site (`apps/web/dist`) on the API's origin, so one tunnel covers site, API and
 * WebSocket (ADR 0015 §1). Mount after the API routes: they win. Hono rejects `..` and `//` paths.
 * Only `/`, `/r/<valid id>` and the built files answer; anything else is a real 404 (OME-764).
 */
export function mountSite(app: Hono, root: string, { origin, previewTitle }: SiteOptions): void {
  const generic = siteMeta(origin, null);
  const html = (c: Context, body: string, status: 200 | 404) => {
    c.header("cache-control", "no-cache");
    return c.html(body, status);
  };
  const notFound = async (c: Context) => {
    const privacy = await readText(join(root, "privacy.html"));
    const page = privacy?.replace(/<title>[^<]*<\/title>/, NOT_FOUND_TITLE).replace(/<main[^>]*>[\s\S]*<\/main>/, NOT_FOUND_MAIN);
    return html(c, page?.includes(NOT_FOUND_MAIN) === true ? page : BARE_NOT_FOUND, 404);
  };
  /** A built page with the share card in its head; never cached, so a rename or takedown shows at once. */
  const page = async (c: Context, name: string, meta: string) => {
    const text = await readText(join(root, name));
    return text === null ? notFound(c) : html(c, withMeta(text, meta), 200);
  };

  // Bun.file throws on a NUL byte; answer 404 instead of a 500 and a logged stack.
  app.use("*", (c, next) => (/%00|\0/.test(c.req.path) ? Promise.resolve(c.notFound()) : next()));
  // Vite content-hashes everything under /assets; a miss there is a 404, never the SPA shell.
  app.use("/assets/*", files(root, undefined, IMMUTABLE));
  app.all("/assets/*", (c) => c.notFound());
  for (const name of PUBLIC_FILES) app.get(`/${name}`, files(PUBLIC_DIR, name, DAY));
  app.get("/", (c) => page(c, "index.html", generic));
  app.get("/index.html", (c) => page(c, "index.html", generic));
  app.get("/r/*", (c, next) => {
    const id = ROOM_ROUTE.exec(c.req.path)?.[1];
    if (id === undefined || !v.is(RoomIdSchema, id)) return next();
    // One Map lookup; unknown, private, hidden and taken-down rooms all get `generic`, byte for byte.
    const title = previewTitle(id);
    return page(c, "index.html", title === null ? generic : siteMeta(origin, title));
  });
  app.get("/:name{[A-Za-z0-9_-]+\\.html}", (c) => page(c, c.req.param("name"), generic));
  app.get("*", files(root));
  app.get("*", notFound);
}
