import { parseConfig, type ServerConfig } from "./config";
import { startServer } from "./server";

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
const server = startServer(config);
const via = config.publicOrigin === null ? "" : `, public origin ${config.publicOrigin}`;
console.log(`omega-share server on ${server.url.href} (site origin ${config.siteOrigin}${via})`);
