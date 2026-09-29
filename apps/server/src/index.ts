import { startServer } from "./server";

const DEFAULT_PORT = 8787;
const port = Number(process.env["PORT"] ?? DEFAULT_PORT);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid PORT: ${String(process.env["PORT"])}`);
const siteOrigin = process.env["SITE_ORIGIN"] ?? "http://localhost:5173";

const server = startServer({ port, siteOrigin, ...(process.env["HOST"] === undefined ? {} : { hostname: process.env["HOST"] }) });
console.log(`omega-share server on ${server.url.href} (site origin ${siteOrigin})`);
