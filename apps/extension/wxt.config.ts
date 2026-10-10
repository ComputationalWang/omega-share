import { fileURLToPath } from "node:url";
import { defineConfig } from "wxt";
import { defaultServerBaseUrl, hostPermissionPattern } from "./src/settings";

/** Toolbar and store icons: the original art in `assets/store/` (R1, OME-509), copied in at build time so there is one source. */
const ICON_SIZES = ["16", "32", "48", "128"] as const;
const icons = Object.fromEntries(ICON_SIZES.map((size) => [size, `icon/${size}.png`]));

/**
 * Firefox only (OME-593, decisions on OME-546). The add-on ID is permanent on AMO: never change it.
 * 140 is the first Firefox that reads `data_collection_permissions`. Share sends the chosen embed URL, which can be
 * the page URL itself (websiteContent, browsingActivity), and the room share token read from the open room tab as
 * `Authorization: Bearer` (authenticationInfo, OME-695). The Chrome listing declares the same three, and an
 * under-declared category risks an AMO rejection of a permanent first listing.
 */
const GECKO = {
  id: "omega-share@omega-share.duckdns.org",
  strict_min_version: "140.0",
  data_collection_permissions: { required: ["websiteContent", "browsingActivity", "authenticationInfo"] },
} as const;
/** Firefox for Android (OME-743, board): 142 is the first Android release that reads `data_collection_permissions`. */
const GECKO_ANDROID = { strict_min_version: "142.0" } as const;

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
    ...(browser === "firefox" ? { browser_specific_settings: { gecko: GECKO, gecko_android: GECKO_ANDROID } } : {}),
    name: "omega share",
    description: "Share the video on this page into an omega-share room.",
    icons,
    action: { default_icon: icons },
    permissions: ["activeTab", "scripting", "storage"],
    host_permissions: [
      ...new Set([
        hostPermissionPattern(defaultServerBaseUrl(mode)),
        // e2e/perf only: Playwright opens the popup as a tab and can't grant activeTab. Port-less patterns cover every
        // port (the default server's http://localhost/* included), so e2e runs on any OMEGA_SERVER_PORT (QA OME-611, OME-687).
        ...(mode === "e2e" ? ["http://localhost/*", "https://www.youtube.com/*"] : []),
      ]),
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
