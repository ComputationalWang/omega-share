import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { PORTS, URLS, available, scripts } from "./e2e/support/apps";

type WebServer = NonNullable<Parameters<typeof defineConfig>[0]["webServer"]>;
const servers: Extract<WebServer, readonly unknown[]>[number][] = [
  { command: "bun e2e/fixtures/server.ts", url: URLS.fixtures, reuseExistingServer: !process.env["CI"] },
];
// App servers are added once their `dev` script exists (OME-5 / OME-6). Perf runs the web app via `preview` (production build).
// Each side is told the other's URL so OMEGA_*_PORT overrides keep the server's origin check and the site's WS target in step.
// The server boots from a fresh DB holding the lobby and the test rooms (e2e/support/test-rooms.ts, OME-341), one file per port.
if (available.server) {
  const db = join(tmpdir(), `omega-e2e-${String(PORTS.server)}.db`);
  servers.push({ command: `bun e2e/fixtures/seed-rooms.ts ${db} && bun run --filter @omega/server dev`, url: URLS.server, reuseExistingServer: !process.env["CI"], env: { PORT: String(PORTS.server), SITE_ORIGIN: URLS.web, DB_PATH: db } });
}
if (available.web) {
  const mode = process.env["OMEGA_WEB_MODE"] === "preview" && "preview" in scripts("web") ? "preview" : "dev";
  servers.push({ command: `bun run --filter @omega/web ${mode} -- --port ${String(PORTS.web)} --strictPort`, url: URLS.web, reuseExistingServer: !process.env["CI"], env: { VITE_SERVER_URL: URLS.server } });
}

// `OMEGA_PERF_MOTION=smooth|basic` forces the walk tier (ADR 0037) in every perf context, so the whole suite can run once per tier.
const perfMotion = process.env["OMEGA_PERF_MOTION"];
const perfStorage = perfMotion === "smooth" || perfMotion === "basic"
  ? { storageState: { cookies: [], origins: [{ origin: URLS.web, localStorage: [{ name: "omega.motion", value: perfMotion }] }] } }
  : {};

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
    // The sync suites pause, play and seek a room, so they once shared the server's only room, the lobby, and ran alone
    // after the rest (OME-90, 154, 164, 131, 314). Now each test has a seeded room of its own (OME-341,
    // e2e/support/test-rooms.ts), so they run alongside `e2e`. They keep a lane: each spec stays serial in one worker,
    // and the lane's worker cap keeps 8-client spread checks from starving each other of CPU.
    { name: "e2e", testDir: "e2e", testMatch: "**/*.e2e.ts", testIgnore: ["**/acceptance.e2e.ts", "**/sync.e2e.ts", "**/vimeo.e2e.ts", "**/provider-*.e2e.ts", "**/tunnel*.e2e.ts", "**/abuse.e2e.ts", "**/http-flood.e2e.ts"], use: { ...devices["Desktop Chrome"], channel: "chromium" } },
    { name: "e2e-sync", testDir: "e2e", testMatch: ["**/acceptance.e2e.ts", "**/sync.e2e.ts", "**/vimeo.e2e.ts", "**/provider-*.e2e.ts"], workers: 4, use: { ...devices["Desktop Chrome"], channel: "chromium" } },
    // Tunnel safety (OME-132): its own tunnel-mode server behind a local TLS proxy on fixed ports, so one worker.
    // The M3 abuse suite (OME-191) and the HTTP flood suite (OME-281) run here too, each on a lane of its own so their spent limits never reach the tunnel specs.
    { name: "e2e-tunnel", testDir: "e2e", testMatch: ["**/tunnel*.e2e.ts", "**/abuse.e2e.ts", "**/http-flood.e2e.ts"], workers: 1, use: { ...devices["Desktop Chrome"], channel: "chromium" } },
    // Opt-in real sign-off checks: YouTube (OME-91, docs/qa/m1b-real-youtube.md), Twitch/Vimeo/tunnel (OME-133, docs/qa/m2-real-sign-off.md).
    // Real network, headed, never in CI. `bun run e2e:real` runs it on a virtual display via e2e/support/headed.ts (OME-210, docs/qa/headed-on-xvfb.md).
    { name: "e2e-real", testDir: "e2e/real", testMatch: "**/*.real.ts", workers: 1, use: { ...devices["Desktop Chrome"], channel: "chromium", headless: false, launchOptions: { args: [AUTOPLAY_DEFAULT] } } },
    // Firefox lane (OME-593): Playwright can't load Firefox extensions, so these specs launch Firefox themselves
    // through Puppeteer over BiDi (e2e/support/firefox.ts) and use only the web servers above. `bun run ext:firefox`.
    { name: "ext-firefox", testDir: "e2e", testMatch: "**/*.firefox.ts", workers: 1 },
    // Tracing off: the trace screencast of every context is software-composited on the shared viz thread and drops vsyncs (ADR 0017).
    { name: "perf", testDir: "perf", testMatch: "**/*.perf.ts", workers: 1, use: { ...devices["Desktop Chrome"], channel: "chromium", trace: "off", ...perfStorage } },
  ],
});
