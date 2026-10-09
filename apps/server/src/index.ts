import type { Database } from "bun:sqlite";
import { startAdmin, type AdminServer } from "./admin";
import { adminSocketFor, parseConfig, type ServerConfig } from "./config";
import { logError } from "./log";
import { startMetrics } from "./metrics";
import { RoomRegistry } from "./rooms";
import { startServer } from "./server";
import { openDatabase } from "./store/db";
import { RoomStore, type SeatHold } from "./store/rooms";

let config: ServerConfig;
let adminSocket: string | null;
try {
  config = parseConfig(process.env);
  adminSocket = adminSocketFor(process.env);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

if (config.publicOrigin !== null && !config.trustProxy) {
  console.warn("PUBLIC_ORIGIN is set without TRUST_PROXY=loopback: all tunnelled clients will share one rate-limit bucket");
}
if (!["127.0.0.1", "::1", "localhost"].includes(config.hostname)) {
  console.warn(`HOST=${config.hostname} is not loopback: the server is reachable without the tunnel (ADR 0015 §3)`);
}
let db: Database;
let store: RoomStore;
try {
  db = openDatabase(config.dbPath);
  store = new RoomStore(db);
} catch (err) {
  console.error(`DB_PATH ${config.dbPath}: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
// Seats the last process held at its graceful restart (ADR 0032); taken once, so a crash loop can't replay them.
let seatHolds: SeatHold[] = [];
try {
  seatHolds = store.takeSeatHolds();
} catch (err) {
  logError("store.seat_holds", err);
}
const rooms = new RoomRegistry();
const server = startServer({ ...config, store, registry: rooms, seatHolds });
const metrics = config.metricsPort === null ? null : startMetrics({ port: config.metricsPort, render: () => server.metricsText() });
let admin: AdminServer | null = null;
if (adminSocket !== null) {
  try {
    admin = startAdmin({ rooms, store, socketPath: adminSocket });
    console.log(`operator CLI socket at ${adminSocket}`);
  } catch (err) {
    // Serving the site matters more than the CLI: say so loudly, keep running.
    console.error(`ADMIN_SOCKET ${adminSocket}: ${err instanceof Error ? err.message : String(err)}; the operator CLI is unavailable`);
  }
}
const via = config.publicOrigin === null ? "" : `, public origin ${config.publicOrigin}`;
console.log(`omega-share server on ${server.url.href} (site origin ${config.siteOrigin}${via})`);
if (metrics !== null) console.log(`metrics on http://127.0.0.1:${String(metrics.port)}/metrics (loopback only)`);

/**
 * Graceful restart (OME-504): stop accepting, close every socket with SERVICE_RESTART (clients reconnect
 * on their own), keep the seats for the next boot, then checkpoint and close the database. systemd sends
 * SIGTERM on `restart` and `stop` (deploy/omega-share.service, TimeoutStopSec).
 */
let draining = false;
async function shutdown(): Promise<void> {
  if (draining) return;
  draining = true;
  let code = 0;
  try {
    const holds = await server.drain();
    void metrics?.stop(true);
    await admin?.stop();
    try {
      store.saveSeatHolds(holds);
    } catch (err) {
      logError("store.seat_holds", err);
    }
    db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
  } catch (err) {
    logError("shutdown", err);
    code = 1;
  }
  process.exit(code);
}
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    void shutdown();
  });
}
