import { fileURLToPath } from "node:url";
import { defineConfig } from "wxt";
import { defaultServerBaseUrl, hostPermissionPattern } from "./src/settings";

/** Toolbar and store icons: the original art in `assets/store/` (R1, OME-509), copied in at build time so there is one source. */
const ICON_SIZES = ["16", "32", "48", "128"] as const;
const icons = Object.fromEntries(ICON_SIZES.map((size) => [size, `icon/${size}.png`]));

/**
 * Firefox only (OME-593, decisions on OME-546). The add-on ID is permanent on AMO: never change it.
 * 140 is the first Firefox that reads `data_collection_permissions`. Share sends the chosen embed URL, which can be
 * the page URL itself, so both categories are declared. Desktop only: no `gecko_android`.
 */
const GECKO = {
  id: "omega-share@omega-share.duckdns.org",
  strict_min_version: "140.0",
  data_collection_permissions: { required: ["websiteContent", "browsingActivity"] },
} as const;

/** `http://localhost:<OMEGA_SERVER_PORT>/*` when the e2e run sets a port other than the default; digits only. */
function e2eServerPortHost(): string[] {
  const port = process.env["OMEGA_SERVER_PORT"];
  return port !== undefined && /^\d{1,5}$/.test(port) && port !== "8787" ? [`http://localhost:${port}/*`] : [];
}

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
    // Firefox would embed the options page in about:addons, where the permissions.request gesture is untested: use a tab.
    "build:manifestGenerated": (wxt, manifest) => {
      if (wxt.config.browser === "firefox" && manifest.options_ui !== undefined) manifest.options_ui.open_in_tab = true;
    },
  },
  manifest: ({ mode, browser }) => ({
    ...(browser === "firefox" ? { browser_specific_settings: { gecko: GECKO } } : {}),
    name: "omega share",
    description: "Share the video on this page into an omega-share room.",
    icons,
    action: { default_icon: icons },
    permissions: ["activeTab", "scripting", "storage"],
    host_permissions: [
      hostPermissionPattern(defaultServerBaseUrl(mode)),
      // e2e/perf only: Playwright opens the popup as a tab and can't grant activeTab.
      ...(mode === "e2e" ? ["http://localhost/*", "https://www.youtube.com/*"] : []),
      // A run on another server port (OMEGA_SERVER_PORT) needs that port too: Firefox doesn't match it against
      // http://localhost/* in permissions.contains, so the popup would ask for access instead of sharing (OME-611).
      ...(mode === "e2e" ? e2eServerPortHost() : []),
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
