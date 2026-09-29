import { defineConfig } from "wxt";
import { DEFAULT_SERVER_BASE_URL, hostPermissionPattern } from "./src/settings";

// Permissions (ADR 0005): activeTab + scripting inject the one-shot scan when the popup opens,
// storage keeps the server URL, and the only host permission is the default server origin.
// Any other server origin is requested at runtime from the options page.
export default defineConfig({
  srcDir: "src",
  imports: false,
  manifest: ({ mode }) => ({
    name: "omega share",
    description: "Share the video on this page into an omega-share room.",
    permissions: ["activeTab", "scripting", "storage"],
    host_permissions: [
      hostPermissionPattern(DEFAULT_SERVER_BASE_URL),
      // e2e/perf only: Playwright opens the popup as a tab and can't grant activeTab.
      ...(mode === "e2e" ? ["http://localhost/*", "https://www.youtube.com/*"] : []),
    ],
    optional_host_permissions: ["http://*/*", "https://*/*"],
  }),
});
