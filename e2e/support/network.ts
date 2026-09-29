// Keep e2e offline and deterministic: every non-localhost request is stubbed.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext, Page } from "@playwright/test";

export const VIDEO_ID = "aqz-KE-bpKQ";
export const WATCH_URL = `https://www.youtube.com/watch?v=${VIDEO_ID}`;
export const EMBED_URL = `https://www.youtube.com/embed/${VIDEO_ID}`;

const PAGES = join(import.meta.dirname, "../fixtures/pages");
const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"]);

export async function stubExternalNetwork(context: BrowserContext): Promise<void> {
  await context.route(
    (url) => (url.protocol === "http:" || url.protocol === "https:") && !LOCAL.has(url.hostname),
    async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname === "www.youtube.com" && url.pathname === "/watch") {
        await route.fulfill({ contentType: "text/html", body: readFileSync(join(PAGES, "watch-url.html"), "utf8") });
        return;
      }
      await route.fulfill({ contentType: "text/html", body: `<!doctype html><title>stub</title><p>stub for ${url.hostname}</p>` });
    },
  );
}

export async function gotoFixture(page: Page, name: "youtube-embed" | "watch-url" | "non-allowlisted" | "no-video"): Promise<void> {
  await page.goto(name === "watch-url" ? WATCH_URL : `/${name}.html`);
}
