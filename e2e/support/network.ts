// Keep e2e offline and deterministic: every non-localhost request is stubbed.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext, Page } from "@playwright/test";
import { installFakeYt } from "../fixtures/fake-iframe-api";
import { installFakeTwitch } from "../fixtures/fake-twitch-embed";
import { installFakeVimeo } from "../fixtures/fake-vimeo-player";

export const VIDEO_ID = "aqz-KE-bpKQ";
export const WATCH_URL = `https://www.youtube.com/watch?v=${VIDEO_ID}`;
export const EMBED_URL = `https://www.youtube.com/embed/${VIDEO_ID}`;

const FIXTURES = join(import.meta.dirname, "../fixtures");
const PAGES = join(FIXTURES, "pages");
const EMBED_HOSTS = new Set(["www.youtube.com", "www.youtube-nocookie.com"]);
// The fake IFrame API (window.YT + window.__fakeYt), see e2e/fixtures/fake-iframe-api.ts. The app's real loader and adapter run against it.
const FAKE_IFRAME_API = `(${installFakeYt.toString()})(window);`;
// Fake Twitch and Vimeo SDKs (OME-121, research §7.1), served at the exact URLs the M2 CSP allows.
const FAKE_TWITCH_SDK = `(${installFakeTwitch.toString()})(window);`;
export const FAKE_VIMEO_SDK = `(${installFakeVimeo.toString()})(window);`;
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
      if (url.hostname === "player.twitch.tv") {
        const sdk = url.pathname === "/js/embed/v1.js";
        const body = sdk ? FAKE_TWITCH_SDK : readFileSync(join(FIXTURES, "twitch-embed.html"), "utf8");
        await route.fulfill({ contentType: sdk ? "text/javascript" : "text/html", body });
        return;
      }
      if (url.hostname === "player.vimeo.com" && url.pathname === "/api/player.js") {
        await route.fulfill({ contentType: "text/javascript", body: FAKE_VIMEO_SDK });
        return;
      }
      if (url.hostname === "player.vimeo.com" && url.pathname.startsWith("/video/")) {
        await route.fulfill({ contentType: "text/html", body: readFileSync(join(FIXTURES, "vimeo-embed.html"), "utf8") });
        return;
      }
      await route.fulfill({ contentType: "text/html", body: `<!doctype html><title>stub</title><p>stub for ${url.hostname}</p>` });
    },
  );
}

const REAL_VIMEO = join(FIXTURES, "vimeo-real-sdk");

/**
 * The real, pinned `@vimeo/player` (`fixtures/vimeo-real-sdk/player.js`, MIT) for `/api/player.js`, and a small Vimeo
 * postMessage protocol stub (`embed.html`) for every other `player.vimeo.com` URL (OME-164). Call after
 * `stubExternalNetwork`: later routes win.
 */
export async function serveRealVimeoSdk(context: BrowserContext): Promise<void> {
  await context.route(
    (url) => url.protocol === "https:" && url.hostname === "player.vimeo.com",
    async (route) => {
      const sdk = new URL(route.request().url()).pathname === "/api/player.js";
      const body = readFileSync(join(REAL_VIMEO, sdk ? "player.js" : "embed.html"), "utf8");
      await route.fulfill({ contentType: sdk ? "text/javascript" : "text/html", body });
    },
  );
}

export async function gotoFixture(page: Page, name: "youtube-embed" | "providers-embed" | "watch-url" | "non-allowlisted" | "no-video" | "generic-embed"): Promise<void> {
  await page.goto(name === "watch-url" ? WATCH_URL : `/${name}.html`);
}
