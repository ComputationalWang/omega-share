import { startAdmin } from "./admin";
import { adminSocketFor, parseConfig, type ServerConfig } from "./config";
import { RoomRegistry } from "./rooms";
import { startServer } from "./server";
import { openDatabase } from "./store/db";
import { RoomStore } from "./store/rooms";

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
let store: RoomStore;
try {
  store = new RoomStore(openDatabase(config.dbPath));
} catch (err) {
  console.error(`DB_PATH ${config.dbPath}: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
const rooms = new RoomRegistry();
const server = startServer({ ...config, store, registry: rooms });
if (adminSocket !== null) {
  try {
    startAdmin({ rooms, store, socketPath: adminSocket });
    console.log(`operator CLI socket at ${adminSocket}`);
  } catch (err) {
    // Serving the site matters more than the CLI: say so loudly, keep running.
    console.error(`ADMIN_SOCKET ${adminSocket}: ${err instanceof Error ? err.message : String(err)}; the operator CLI is unavailable`);
  }
}
const via = config.publicOrigin === null ? "" : `, public origin ${config.publicOrigin}`;
console.log(`omega-share server on ${server.url.href} (site origin ${config.siteOrigin}${via})`);
