import { parseConfig, type ServerConfig } from "./config";
import { startServer } from "./server";
import { openDatabase } from "./store/db";
import { RoomStore } from "./store/rooms";

let config: ServerConfig;
try {
  config = parseConfig(process.env);
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
const server = startServer({ ...config, store });
const via = config.publicOrigin === null ? "" : `, public origin ${config.publicOrigin}`;
console.log(`omega-share server on ${server.url.href} (site origin ${config.siteOrigin}${via})`);
