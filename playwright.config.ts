import { defineConfig, devices } from "@playwright/test";
import { PORTS, URLS, available, scripts } from "./e2e/support/apps";

type WebServer = NonNullable<Parameters<typeof defineConfig>[0]["webServer"]>;
const servers: Extract<WebServer, readonly unknown[]>[number][] = [
  { command: "bun e2e/fixtures/server.ts", url: URLS.fixtures, reuseExistingServer: !process.env["CI"] },
];
// App servers are added once their `dev` script exists (OME-5 / OME-6). Perf runs the web app via `preview` (production build).
if (available.server) {
  servers.push({ command: "bun run --filter @omega/server dev", url: URLS.server, reuseExistingServer: !process.env["CI"], env: { PORT: String(PORTS.server) } });
}
if (available.web) {
  const mode = process.env["OMEGA_WEB_MODE"] === "preview" && "preview" in scripts("web") ? "preview" : "dev";
  servers.push({ command: `bun run --filter @omega/web ${mode} -- --port ${String(PORTS.web)} --strictPort`, url: URLS.web, reuseExistingServer: !process.env["CI"] });
}

export default defineConfig({
  outputDir: "test-results",
  reporter: process.env["CI"] ? [["list"], ["html", { open: "never" }]] : "list",
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 1 : 0,
  use: { baseURL: URLS.fixtures, trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: servers,
  projects: [
    { name: "e2e", testDir: "e2e", testMatch: "**/*.e2e.ts", use: { ...devices["Desktop Chrome"], channel: "chromium" } },
    { name: "perf", testDir: "perf", testMatch: "**/*.perf.ts", workers: 1, use: { ...devices["Desktop Chrome"], channel: "chromium" } },
  ],
});
