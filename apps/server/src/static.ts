import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Hono } from "hono";
import { serveStatic } from "hono/serve-static";

/** A path with no file extension in its last segment is a site route (`/`, `/r/:room`). */
const SITE_ROUTE = /^\/(?:[^.]*\/)?[^/.]*$/;
const IMMUTABLE = "public, max-age=31536000, immutable";

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
 */
export function mountSite(app: Hono, root: string): void {
  const index = files(root, "index.html", "no-cache");
  // Bun.file throws on a NUL byte; answer 404 instead of a 500 and a logged stack.
  app.use("*", (c, next) => (/%00|\0/.test(c.req.path) ? Promise.resolve(c.notFound()) : next()));
  // Vite content-hashes everything under /assets; a miss there is a 404, never the SPA shell.
  app.use("/assets/*", files(root, undefined, IMMUTABLE));
  app.all("/assets/*", (c) => c.notFound());
  app.get("/", index);
  app.get("*", files(root));
  app.get("*", (c, next) => (SITE_ROUTE.test(c.req.path) ? index(c, next) : next()));
}
