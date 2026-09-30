// Keep e2e offline and deterministic: every non-localhost request is stubbed.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext, Page } from "@playwright/test";
import { installFakeYt } from "../fixtures/fake-iframe-api";

export const VIDEO_ID = "aqz-KE-bpKQ";
export const WATCH_URL = `https://www.youtube.com/watch?v=${VIDEO_ID}`;
export const EMBED_URL = `https://www.youtube.com/embed/${VIDEO_ID}`;

const FIXTURES = join(import.meta.dirname, "../fixtures");
const PAGES = join(FIXTURES, "pages");
const EMBED_HOSTS = new Set(["www.youtube.com", "www.youtube-nocookie.com"]);
// The fake IFrame API (window.YT + window.__fakeYt), see e2e/fixtures/fake-iframe-api.ts. The app's real loader and adapter run against it.
const FAKE_IFRAME_API = `(${installFakeYt.toString()})(window);`;
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
      if (url.hostname === "www.youtube.com" && url.pathname === "/iframe_api") {
        await route.fulfill({ contentType: "text/javascript", body: FAKE_IFRAME_API });
        return;
      }
      if (EMBED_HOSTS.has(url.hostname) && url.pathname.startsWith("/embed/")) {
        await route.fulfill({ contentType: "text/html", body: readFileSync(join(FIXTURES, "yt-embed.html"), "utf8") });
        return;
      }
      await route.fulfill({ contentType: "text/html", body: `<!doctype html><title>stub</title><p>stub for ${url.hostname}</p>` });
    },
  );
}

export async function gotoFixture(page: Page, name: "youtube-embed" | "watch-url" | "non-allowlisted" | "no-video"): Promise<void> {
  await page.goto(name === "watch-url" ? WATCH_URL : `/${name}.html`);
}
