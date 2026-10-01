import type { Server } from "bun";
import { DEFAULT_LAYOUT, DEFAULT_ROOM_ID, type AnyEmbed, type RoomId, type ShareToken } from "@omega/shared";
import { ownHostsFor } from "./config";
import { EmbedPolicy } from "./embed-policy";
import { securityHeaders } from "./headers";
import { MAX_HTTP_IN_FLIGHT, createHttpApp, createHttpGate, plain as plainWith, type ShareGrant } from "./http";
import { clientKey, monotonic, type Clock } from "./rate-limit";
import { Room } from "./room";
import type { RoomStore } from "./store/rooms";
import { createWs, type ConnData } from "./ws";

export interface ServerOptions {
  port: number;
  /** Default `127.0.0.1`: only the tunnel agent (or the operator) reaches the server (ADR 0015 §3). */
  hostname?: string;
  /** The dev site's origin, e.g. `http://localhost:5173`. It, the public origin, our own loopback origins and extension origins may call the API. */
  siteOrigin: string;
  /** The tunnel's `https://` origin; its host joins the Host allowlist and it joins the Origin allowlist. */
  publicOrigin?: string | null;
  /** Serve this built site (`apps/web/dist`, absolute path) on the same origin as the API. */
  staticDir?: string | null;
  /** Allowed extension ids; null or absent allows any Chromium extension id. */
  extensionIds?: readonly string[] | null;
  /** Sockets that have not joined within this are closed. Default 10 s. */
  joinTimeoutMs?: number;
  /** Key limits by the rightmost `X-Forwarded-For` entry when the peer is loopback (the tunnel agent). */
  trustProxy?: boolean;
  /** Open WebSockets allowed per client. Default 10 behind the proxy, 50 locally (the load test). */
  maxConnectionsPerIp?: number;
  /** Open WebSockets allowed in total, whatever their clients. Default 200. */
  maxConnections?: number;
  /** HTTP requests handled at once, whatever their clients; more get 503. Default 256. */
  maxHttpInFlight?: number;
  /** Rooms that exist. Default: just the lobby. With a store, these are seeded if missing. */
  rooms?: readonly RoomId[];
  /**
   * Where rooms, layouts and last embeds persist (OME-280). Read once at boot, written only on a
   * share; never on the relay path. Absent: rooms live in memory with DEFAULT_LAYOUT.
   */
  store?: RoomPersistence | null;
  /** Clock for the WS and HTTP limiters (tests inject one so a refill needs no sleep). Default: monotonic. */
  now?: Clock;
  /** `member-status` coalescing interval (ADR 0019 §3). Default 1 s; tests shorten it. */
  statusIntervalMs?: number;
  /** GENERIC_EMBEDS: accept the generic embed tier (ADR 0024). Default true. */
  genericEmbeds?: boolean;
  /** Domains refused for generic embeds, with their subdomains (GENERIC_EMBED_DENYLIST). Default none. */
  genericEmbedDenylist?: readonly string[];
  /** Our own hostnames, refused as generic embeds. Default: `ownHostsFor(siteOrigin, publicOrigin)`. */
  ownHosts?: readonly string[];
}

/** The slice of RoomStore the server uses. */
export type RoomPersistence = Pick<RoomStore, "listRooms" | "createRoom" | "setEmbed">;

/**
 * Every stored room, plus the configured ones the store lacks, seeded with DEFAULT_LAYOUT. A stored
 * embed the policy no longer accepts (GENERIC_EMBEDS=off, a newly denied host) comes back as null;
 * the row keeps it, so switching back restores it.
 */
function loadRooms(configured: readonly RoomId[], store: RoomPersistence | null, embeds: EmbedPolicy): Map<string, Room> {
  const rooms = new Map<string, Room>();
  if (store !== null) {
    for (const r of store.listRooms()) rooms.set(r.id, new Room(r.id, { layout: r.layout, embed: embeds.restore(r.embed) }));
  }
  const now = Date.now();
  for (const id of configured) {
    if (rooms.has(id)) continue;
    store?.createRoom({ id, title: "", createdAt: now, layout: DEFAULT_LAYOUT });
    rooms.set(id, new Room(id));
  }
  return rooms;
}

const WS_PATH = /^\/rooms\/([^/]+)\/ws$/;
/** Any Chromium extension id, unless `extensionIds` (EXTENSION_IDS) pins the published ones. */
const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;

export function startServer(opts: ServerOptions): Server<ConnData> {
  const trustProxy = opts.trustProxy ?? false;
  const maxConnectionsPerIp = opts.maxConnectionsPerIp ?? (trustProxy ? 10 : 50);
  const maxConnections = opts.maxConnections ?? 200;
  let connections = 0;
  const store = opts.store ?? null;
  const embeds = new EmbedPolicy({
    genericEmbeds: opts.genericEmbeds ?? true,
    ownHosts: opts.ownHosts ?? ownHostsFor(opts.siteOrigin, opts.publicOrigin ?? null),
    denylist: opts.genericEmbedDenylist ?? [],
  });
  const headers = securityHeaders(embeds.genericEmbeds);
  const plain = (status: number, text: string): Response => plainWith(status, text, headers);
  const rooms = loadRooms(opts.rooms ?? [DEFAULT_ROOM_ID], store, embeds);
  const connectionsPerIp = new Map<string, number>();
  const shareGrants = new Map<ShareToken, ShareGrant>();

  // Filled in once Bun has picked the port (tests use port 0); no request arrives before that.
  const allowedHosts = new Set<string>();
  const allowedOrigins = new Set<string>([opts.siteOrigin]);
  const extensionOrigins = opts.extensionIds?.map((id) => `chrome-extension://${id}`) ?? null;
  const isAllowedOrigin = (origin: string): boolean =>
    allowedOrigins.has(origin) || (extensionOrigins === null ? EXTENSION_ORIGIN.test(origin) : extensionOrigins.includes(origin));
  /** Refuses DNS rebinding: only our public host and loopback names on our port (ADR 0015 §4). */
  const hostOk = (req: Request): boolean => allowedHosts.has(req.headers.get("host")?.toLowerCase() ?? "");
  /** Browsers always send Origin cross-origin; non-browser clients may omit it and are not a CSRF vector. */
  const originOk = (req: Request): boolean => {
    const origin = req.headers.get("origin");
    return origin === null || isAllowedOrigin(origin);
  };
  const ipOf = (req: Request): string =>
    clientKey(server.requestIP(req)?.address ?? "unknown", req.headers.get("x-forwarded-for"), trustProxy);
  const publish = (topic: string, data: string): void => {
    server.publish(topic, data);
  };

  const persistEmbed = (room: Room, embed: AnyEmbed): void => {
    store?.setEmbed(room.id, embed);
  };

  const app = createHttpApp({ rooms, shareGrants, isAllowedOrigin, ipOf, publish, persistEmbed, embeds, headers, staticDir: opts.staticDir ?? null });
  const http = createHttpGate((req) => app.fetch(req), {
    now: opts.now ?? monotonic,
    maxInFlight: opts.maxHttpInFlight ?? MAX_HTTP_IN_FLIGHT,
    headers,
  });
  const ws = createWs({
    joinTimeoutMs: opts.joinTimeoutMs ?? 10_000,
    shareGrants,
    publish,
    headers,
    now: opts.now ?? monotonic,
    ...(opts.statusIntervalMs === undefined ? {} : { statusIntervalMs: opts.statusIntervalMs }),
    release(ip) {
      connections--;
      const left = (connectionsPerIp.get(ip) ?? 1) - 1;
      if (left === 0) connectionsPerIp.delete(ip);
      else connectionsPerIp.set(ip, left);
    },
  });

  const server: Server<ConnData> = Bun.serve<ConnData>({
    port: opts.port,
    hostname: opts.hostname ?? "127.0.0.1",
    maxRequestBodySize: 64 * 1024,
    fetch(req, srv) {
      // Before routing, for HTTP and upgrades alike (ADR 0015 §4).
      if (!hostOk(req)) return plain(421, "misdirected request");
      // Not a ShareResponse: the contract has no code for it, and only a hostile page can trigger it.
      if (!originOk(req)) return plain(403, "forbidden origin");
      // Cheap test first so ordinary HTTP requests skip URL parsing.
      if (!req.url.includes("/ws")) return http(req, ipOf(req));
      const match = WS_PATH.exec(new URL(req.url).pathname);
      if (match === null) return http(req, ipOf(req));
      const room = rooms.get(match[1] ?? "");
      if (room === undefined) return plain(404, "unknown room");
      if (connections >= maxConnections) return plain(503, "server full");
      const ip = ipOf(req);
      const open = connectionsPerIp.get(ip) ?? 0;
      if (open >= maxConnectionsPerIp) return plain(429, "too many connections");
      const refused = ws.admitUpgrade(ip);
      if (refused !== null) return refused;
      if (!srv.upgrade(req, { data: ws.connData(room, ip) })) return plain(426, "expected a WebSocket upgrade");
      connectionsPerIp.set(ip, open + 1);
      connections++;
      return undefined;
    },
    websocket: ws.websocket,
  });
  const port = String(server.port);
  for (const name of ["localhost", "127.0.0.1", "[::1]"]) {
    allowedHosts.add(`${name}:${port}`);
    // A page served from here (STATIC_DIR, or anything else on our port) is us.
    allowedOrigins.add(`http://${name}:${port}`);
  }
  if (opts.publicOrigin != null) {
    allowedHosts.add(new URL(opts.publicOrigin).host);
    allowedOrigins.add(opts.publicOrigin);
  }
  return server;
}
