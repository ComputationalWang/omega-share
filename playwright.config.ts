import { defineConfig, devices } from "@playwright/test";
import { PORTS, URLS, available, scripts } from "./e2e/support/apps";

type WebServer = NonNullable<Parameters<typeof defineConfig>[0]["webServer"]>;
const servers: Extract<WebServer, readonly unknown[]>[number][] = [
  { command: "bun e2e/fixtures/server.ts", url: URLS.fixtures, reuseExistingServer: !process.env["CI"] },
];
// App servers are added once their `dev` script exists (OME-5 / OME-6). Perf runs the web app via `preview` (production build).
// Each side is told the other's URL so OMEGA_*_PORT overrides keep the server's origin check and the site's WS target in step.
if (available.server) {
  servers.push({ command: "bun run --filter @omega/server dev", url: URLS.server, reuseExistingServer: !process.env["CI"], env: { PORT: String(PORTS.server), SITE_ORIGIN: URLS.web } });
}
if (available.web) {
  const mode = process.env["OMEGA_WEB_MODE"] === "preview" && "preview" in scripts("web") ? "preview" : "dev";
  servers.push({ command: `bun run --filter @omega/web ${mode} -- --port ${String(PORTS.web)} --strictPort`, url: URLS.web, reuseExistingServer: !process.env["CI"], env: { VITE_SERVER_URL: URLS.server } });
}

// Chrome's own default: sound needs a user activation (item 3 of the real-YouTube checklist relies on it).
const AUTOPLAY_DEFAULT = "--autoplay-policy=document-user-activation-required";

export default defineConfig({
  outputDir: "test-results",
  reporter: process.env["CI"] ? [["list"], ["html", { open: "never" }]] : "list",
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 1 : 0,
  use: { baseURL: URLS.fixtures, trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: servers,
  projects: [
    // The sync suites pause, play and seek the shared lobby (the server hosts only that room), so they run alone, after the rest (OME-90).
    // The smoke joins them: in parallel with acceptance's shares it saw another spec's state land between A's pause and B's poll (OME-154).
    // The Vimeo suite re-shares the lobby with a Vimeo video in every case, so it joins them too (OME-164).
    // So do the provider sync and share-from-extension suites (OME-131).
    { name: "e2e", testDir: "e2e", testMatch: "**/*.e2e.ts", testIgnore: ["**/sync.e2e.ts", "**/sync-smoke.e2e.ts", "**/vimeo.e2e.ts", "**/provider-*.e2e.ts", "**/tunnel*.e2e.ts", "**/abuse.e2e.ts"], use: { ...devices["Desktop Chrome"], channel: "chromium" } },
    { name: "e2e-sync", testDir: "e2e", testMatch: ["**/sync.e2e.ts", "**/sync-smoke.e2e.ts", "**/vimeo.e2e.ts", "**/provider-*.e2e.ts"], workers: 1, dependencies: ["e2e"], use: { ...devices["Desktop Chrome"], channel: "chromium" } },
    // Tunnel safety (OME-132): its own tunnel-mode server behind a local TLS proxy on fixed ports, so one worker.
    // The M3 abuse suite (OME-191) runs here too, on a lane of its own so its spent limits never reach the tunnel specs.
    { name: "e2e-tunnel", testDir: "e2e", testMatch: ["**/tunnel*.e2e.ts", "**/abuse.e2e.ts"], workers: 1, use: { ...devices["Desktop Chrome"], channel: "chromium" } },
    // Opt-in real sign-off checks: YouTube (OME-91, docs/qa/m1b-real-youtube.md), Twitch/Vimeo/tunnel (OME-133, docs/qa/m2-real-sign-off.md).
    // Real network, headed, never in CI. `bun run e2e:real` runs it on a virtual display via e2e/support/headed.ts (OME-210, docs/qa/headed-on-xvfb.md).
    { name: "e2e-real", testDir: "e2e/real", testMatch: "**/*.real.ts", workers: 1, use: { ...devices["Desktop Chrome"], channel: "chromium", headless: false, launchOptions: { args: [AUTOPLAY_DEFAULT] } } },
    { name: "perf", testDir: "perf", testMatch: "**/*.perf.ts", workers: 1, use: { ...devices["Desktop Chrome"], channel: "chromium" } },
  ],
});
