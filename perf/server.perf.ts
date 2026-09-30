import { spawnSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import * as v from "valibot";
import { CLOSE_CODES, DEFAULT_ROOM_ID, MAX_ROOM_MEMBERS } from "@omega/shared";
import { PENDING, ROOT, URLS, available } from "../e2e/support/apps";
import { recordMetric } from "./metrics";
import { shareVideo } from "./sync";

// The probe sets `Origin` via Bun's WebSocket options, which Playwright's Node runner lacks, so run its CLI under Bun.
const Count = v.pipe(v.number(), v.integer(), v.minValue(0));
const ProbeOutput = v.object({
  p95: v.pipe(v.number(), v.finite()),
  members: v.optional(v.object({ chats: Count, rateLimited: Count })),
  attacker: v.optional(v.object({ sent: Count, rateLimited: Count, closes: v.record(v.string(), Count) })),
});
type ProbeOutput = v.InferOutput<typeof ProbeOutput>;

function probe(ws: URL, action: "seat" | "control", flood = false): ProbeOutput {
  const args = ["--url", ws.href, "--clients", String(MAX_ROOM_MEMBERS), "--samples", "50", "--origin", URLS.web, "--budget", "Infinity", "--action", action];
  const proc = spawnSync("bun", ["apps/server/src/relay-latency.ts", ...args, ...(flood ? ["--flood"] : [])], { cwd: ROOT, encoding: "utf8" });
  expect(proc.status, proc.stderr).toBe(0);
  const lines = proc.stdout.trim().split("\n");
  return v.parse(ProbeOutput, JSON.parse(lines[lines.length - 1] ?? "null"));
}

const wsUrl = (): URL => {
  const ws = new URL(`/rooms/${DEFAULT_ROOM_ID}/ws`, URLS.server);
  ws.protocol = ws.protocol === "https:" ? "wss:" : "ws:";
  return ws;
};

test("server: relay latency for a control action", async ({ request }) => {
  if (!available.server) {
    recordMetric({ id: "server.relayLatency", pending: PENDING.server });
    return;
  }
  const ws = wsUrl();
  // A `control` needs an embed; the probe seeks it and restores the playback it found.
  await shareVideo(request);
  const control = probe(ws, "control").p95;
  const seat = probe(ws, "seat").p95;
  recordMetric({ id: "server.relayLatency", value: control, note: `control seek → playback at all ${String(MAX_ROOM_MEMBERS)} sockets, p95 of 50; sit/stand p95 ${seat.toFixed(1)} ms` });
});

// Threat model §8 Q: 24 members chat at the sustained chat rate while seeks run at the room's control limit,
// and 1 socket floods chat at 10× L1 (100/s), rejoining after every close.
test("server: relay latency for a control action under flood", async ({ request }) => {
  if (!available.server) {
    recordMetric({ id: "server.relayLatencyFlood", pending: PENDING.server });
    return;
  }
  test.setTimeout(60_000);
  await shareVideo(request);
  const r = probe(wsUrl(), "control", true);
  const { members, attacker } = r;
  if (members === undefined || attacker === undefined) throw new Error("relay-latency --flood: no members/attacker stats");
  const closes4029 = attacker.closes[String(CLOSE_CODES.RATE_LIMITED)] ?? 0;
  const closes = Object.entries(attacker.closes).map(([code, n]) => `${code}×${String(n)}`).join(", ") || "none";
  recordMetric({
    id: "server.relayLatencyFlood",
    value: r.p95,
    note: `control seek → playback at ${String(MAX_ROOM_MEMBERS - 1)} members, p95 of 50; members sent ${String(members.chats)} chats, ${String(members.rateLimited)} rate_limited; attacker sent ${String(attacker.sent)}, got ${String(attacker.rateLimited)} rate_limited, closes ${closes}`,
  });
  // Legitimate traffic is never rate-limited; the attacker is throttled or closed with 4029 (ADR 0016).
  expect(members.chats).toBeGreaterThan(0);
  expect(members.rateLimited).toBe(0);
  expect(attacker.rateLimited + closes4029).toBeGreaterThan(0);
});
