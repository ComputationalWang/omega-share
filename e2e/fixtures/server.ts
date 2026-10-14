// Static server for fixture pages, started by Playwright's webServer. Only serves files in ./pages.
import { join, normalize } from "node:path";
import { PORTS } from "../support/apps";

const PAGES = join(import.meta.dirname, "pages");

Bun.serve({
  port: PORTS.fixtures,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    const rel = normalize(path === "/" ? "/index.html" : path);
    const file = Bun.file(join(PAGES, rel));
    if (rel.includes("..") || !(await file.exists())) return new Response("not found", { status: 404 });
    // A generic host that refuses to be framed (OME-1040, e2e/unlock.e2e.ts).
    if (rel === "/xfo-frame.html") return new Response(file, { headers: { "X-Frame-Options": "DENY" } });
    // A kwik-style Referer gate (OME-1055, ADR 0047 §3): 403 unless the request claims the host framed itself.
    if (rel === "/referer-frame.html" && req.headers.get("referer") !== `https://${new URL(req.url).hostname}/`) return new Response("forbidden", { status: 403 });
    return new Response(file);
  },
});
console.log(`fixtures on http://localhost:${String(PORTS.fixtures)}`);
