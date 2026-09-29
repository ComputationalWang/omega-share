import { test } from "@playwright/test";
import { PENDING, available } from "../e2e/support/apps";
import { recordMetric } from "./metrics";

test("server: relay latency for a control action", () => {
  // Needs the WS message union from packages/shared (OME-4) and the relay (OME-5); measurement lands with OME-9.
  recordMetric({
    id: "server.relayLatency",
    pending: available.server ? "measurement lands with OME-9 (needs OME-4 WS contract)" : PENDING.server,
  });
});
