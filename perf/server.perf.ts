import { spawnSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { DEFAULT_ROOM_ID, MAX_ROOM_MEMBERS } from "@omega/shared";
import { PENDING, ROOT, URLS, available } from "../e2e/support/apps";
import { recordMetric } from "./metrics";

// The probe sets `Origin` via Bun's WebSocket options, which Playwright's Node runner lacks, so run its CLI under Bun.
function p95Of(x: unknown): number {
  if (typeof x !== "object" || x === null || !("p95" in x) || typeof x.p95 !== "number" || !Number.isFinite(x.p95)) {
    throw new Error(`relay-latency: unexpected output ${JSON.stringify(x)}`);
  }
  return x.p95;
}

test("server: relay latency for a control action", () => {
  if (!available.server) {
    recordMetric({ id: "server.relayLatency", pending: PENDING.server });
    return;
  }
  const ws = new URL(`/rooms/${DEFAULT_ROOM_ID}/ws`, URLS.server);
  ws.protocol = ws.protocol === "https:" ? "wss:" : "ws:";
  const args = ["--url", ws.href, "--clients", String(MAX_ROOM_MEMBERS), "--samples", "50", "--origin", URLS.web, "--budget", "Infinity"];
  const proc = spawnSync("bun", ["apps/server/src/relay-latency.ts", ...args], { cwd: ROOT, encoding: "utf8" });
  expect(proc.status, proc.stderr).toBe(0);
  const lines = proc.stdout.trim().split("\n");
  const p95 = p95Of(JSON.parse(lines[lines.length - 1] ?? "null"));
  recordMetric({ id: "server.relayLatency", value: p95 });
});
