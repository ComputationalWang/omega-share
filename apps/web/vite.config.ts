import { defineConfig, loadEnv, type Plugin } from "vite";
import { devConnectSrc, withConnectSrc } from "./csp";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildSha, withBuildInfo } from "./build-info";
import { CHROME_LISTING_URL, FIREFOX_LISTING_URL, withInstallLinks } from "./install";
import { sourceUrl, withSourceLink } from "./source";

/** Keeps the meta CSP's dev origins in step with VITE_SERVER_URL and the dev server port (see csp.ts). */
function cspDevOrigins(mode: string): Plugin {
  const serverUrl = process.env["VITE_SERVER_URL"] ?? loadEnv(mode, process.cwd(), "VITE_")["VITE_SERVER_URL"];
  return {
    name: "omega-csp-dev-origins",
    transformIndexHtml: {
      order: "pre",
      handler(html, ctx) {
        const webPort = ctx.server?.config.server.port;
        return withConnectSrc(html, devConnectSrc({ serverUrl, webPort }));
      },
    },
  };
}

/** Fills the footer's AGPL-3.0 §13 Source link (see source.ts). */
function sourceLink(mode: string): Plugin {
  const url = sourceUrl(process.env["VITE_SOURCE_URL"] ?? loadEnv(mode, process.cwd(), "VITE_")["VITE_SOURCE_URL"]);
  return { name: "omega-source-link", transformIndexHtml: { order: "pre", handler: (html) => withSourceLink(html, url) } };
}

/** index.html's relative path to the set (m) site art; the build hashes those files into /assets. */
const SITE_ART_HREF = "../../assets/site/";

/**
 * The landing's install row and the footer's build sha (OME-767, see install.ts and build-info.ts). The dev server
 * doesn't rewrite a relative <img src> that climbs above its root, so in dev the panels load through /@fs instead.
 */
function landing(): Plugin {
  const git = (): string => execFileSync("git", ["rev-parse", "--short=7", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const sha = buildSha(process.env["OMEGA_BUILD_SHA"], git);
  const listings = { firefox: FIREFOX_LISTING_URL, chrome: CHROME_LISTING_URL };
  const devArt = `/@fs${fileURLToPath(new URL(SITE_ART_HREF, import.meta.url))}`;
  return {
    name: "omega-landing",
    transformIndexHtml: {
      order: "pre",
      handler(html, ctx) {
        const page = withBuildInfo(withInstallLinks(html, listings), sha);
        return ctx.server === undefined ? page : page.replaceAll(SITE_ART_HREF, devArt);
      },
    },
  };
}

/** The D1 "how it works" panels stay files (lazy, cached), never data: URLs in the page. */
const SITE_ART = /[\\/]assets[\\/]site[\\/]/;

export default defineConfig(({ mode }) => ({
  plugins: [cspDevOrigins(mode), sourceLink(mode), landing()],
  build: {
    assetsInlineLimit: (file: string) => (SITE_ART.test(file) ? false : undefined),
    target: "es2023",
    sourcemap: true,
    reportCompressedSize: true,
    // The privacy notice (OME-411) is a second, script-free page; it adds nothing to the room's JS.
    // The pop-out chat (OME-598) is a third page with its own small chunk: no Pixi, no socket.
    // The pop-out room (OME-600) is a fourth: the stage (Pixi, shared with the room's lazy chunk) and the chat, no socket.
    // Terms, Contact & notices and Licences & credits (OME-766) are script-free like the privacy notice.
    rolldownOptions: {
      input: {
        index: "index.html",
        privacy: "privacy.html",
        terms: "terms.html",
        contact: "contact.html",
        licenses: "licenses.html",
        chat: "chat.html",
        room: "room.html",
      },
    },
  },
}));
