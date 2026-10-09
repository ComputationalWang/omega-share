import { defineConfig, loadEnv, type Plugin } from "vite";
import { devConnectSrc, withConnectSrc } from "./csp";
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

export default defineConfig(({ mode }) => ({
  plugins: [cspDevOrigins(mode), sourceLink(mode)],
  build: {
    target: "es2023",
    sourcemap: true,
    reportCompressedSize: true,
    // The privacy notice (OME-411) is a second, script-free page; it adds nothing to the room's JS.
    // The pop-out chat (OME-598) is a third page with its own small chunk: no Pixi, no socket.
    // The pop-out room (OME-600) is a fourth: the stage (Pixi, shared with the room's lazy chunk) and the chat, no socket.
    rolldownOptions: { input: { index: "index.html", privacy: "privacy.html", chat: "chat.html", room: "room.html" } },
  },
}));
