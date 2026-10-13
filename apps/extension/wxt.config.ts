import { fileURLToPath } from "node:url";
import { defineConfig } from "wxt";
import { defaultServerBaseUrl, hostPermissionPattern } from "./src/settings";

/** Toolbar and store icons: the original art in `assets/store/` (R1, OME-509), copied in at build time so there is one source. */
const ICON_SIZES = ["16", "32", "48", "128"] as const;
/** Popup state vignettes (OME-842 art, used by OME-857), copied in the same way. */
const POPUP_VIGNETTES = ["nothing-found", "cant-read", "server-away"].flatMap((name) => [`${name}.png`, `${name}@2x.png`]);
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
const UNLOCK_PERMISSION = "declarativeNetRequestWithHostAccess";
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
      for (const file of POPUP_VIGNETTES) {
        files.push({ absoluteSrc: fileURLToPath(new URL(`../../assets/ui/popup/${file}`, import.meta.url)), relativeDest: `popup/${file}` });
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
    // "Unlock with extension" (ADR 0047 §4): Chromium asks for DNR with the one host it unlocks. Firefox can't make it
    // optional, and there it has no prompt and acts only on hosts the viewer granted. The e2e builds hold it because
    // Playwright can't click the permission prompt.
    permissions: ["activeTab", "scripting", "storage", ...(browser === "firefox" || mode === "e2e" ? [UNLOCK_PERMISSION] : [])],
    ...(browser === "firefox" ? {} : { optional_permissions: [UNLOCK_PERMISSION] }),
    host_permissions: [
      ...new Set([
        hostPermissionPattern(defaultServerBaseUrl(mode)),
        // e2e/perf only: Playwright opens the popup as a tab and can't grant activeTab. Port-less patterns cover every
        // port (the default server's http://localhost/* included), so e2e runs on any OMEGA_SERVER_PORT (QA OME-611, OME-687).
        // xfo.omega-fixture.net is the unlock spec's X-Frame-Options host, granted as a viewer would (e2e/unlock.e2e.ts).
        ...(mode === "e2e" ? ["http://localhost/*", "https://www.youtube.com/*", "http://xfo.omega-fixture.net/*", "https://xfo.omega-fixture.net/*"] : []),
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
