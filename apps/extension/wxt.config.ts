import { fileURLToPath } from "node:url";
import { defineConfig } from "wxt";
import { defaultServerBaseUrl, hostPermissionPattern } from "./src/settings";

/** Toolbar and store icons: the original art in `assets/store/` (R1, OME-509), copied in at build time so there is one source. */
const ICON_SIZES = ["16", "32", "48", "128"] as const;
const icons = Object.fromEntries(ICON_SIZES.map((size) => [size, `icon/${size}.png`]));

// Permissions (ADR 0005): activeTab + scripting inject the one-shot scan when the popup opens,
// storage keeps the server URL, and the only host permission is the default server origin:
// the hosted https server in the production (store) build, the local server in dev and e2e.
// Any other server origin is requested at runtime from the options page.
export default defineConfig({
  srcDir: "src",
  imports: false,
  hooks: {
    "build:publicAssets": (_wxt, files) => {
      for (const size of ICON_SIZES) {
        files.push({ absoluteSrc: fileURLToPath(new URL(`../../assets/store/icon-${size}.png`, import.meta.url)), relativeDest: `icon/${size}.png` });
      }
    },
  },
  manifest: ({ mode }) => ({
    name: "omega share",
    description: "Share the video on this page into an omega-share room.",
    icons,
    action: { default_icon: icons },
    permissions: ["activeTab", "scripting", "storage"],
    host_permissions: [
      hostPermissionPattern(defaultServerBaseUrl(mode)),
      // e2e/perf only: Playwright opens the popup as a tab and can't grant activeTab.
      ...(mode === "e2e" ? ["http://localhost/*", "https://www.youtube.com/*"] : []),
    ],
    // What parseServerBaseUrl accepts: https anywhere, cleartext only on this computer (any port).
    optional_host_permissions: ["https://*/*", "http://localhost/*", "http://127.0.0.1/*", "http://[::1]/*"],
    // Threat model §10 X: pin the extension-page CSP instead of relying on Chrome's default.
    // connect-src stays open because the user picks the server origin.
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    },
  }),
});
