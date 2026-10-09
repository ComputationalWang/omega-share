import type { Server } from "bun";
import { DEFAULT_LAYOUT, DEFAULT_ROOM_ID, QUEUE_MAX, type AnyEmbed, type QueueItemId, type RoomId } from "@omega/shared";
import { nicknameKey } from "@omega/shared/confusables";
import { ownHostsFor } from "./config";
import { EmbedPolicy } from "./embed-policy";
import { HSTS, securityHeaders } from "./headers";
import { MAX_HTTP_IN_FLIGHT, createHttpApp, createHttpGate, plain as plainWith } from "./http";
import { createQueue } from "./queue";
import { clientKey, monotonic, type Clock } from "./rate-limit";
import { Room, SEAT_HOLD_MS } from "./room";
import { RoomRegistry } from "./rooms";
import { ROOM_GC_INTERVAL_MS, startRoomGc } from "./rooms-gc";
import type { RoomStore, SeatHold } from "./store/rooms";
import { createWs, type ConnData } from "./ws";
import { logError } from "./log";
import { Metrics } from "./metrics";

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
  /** The live rooms, seeded here from `rooms` and the store. Tests pass their own to add and remove rooms. */
  registry?: RoomRegistry;
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
  /** ROOM_TITLE_BLOCKLIST: titles containing one of these (case and lookalikes folded) can't be created or listed. Default none. */
  roomTitleBlocklist?: readonly string[];
  /** Unix ms clock for `created_at`, `last_active_at` and room GC (tests inject one). Default `Date.now`. */
  wallNow?: () => number;
  /** Room GC sweep interval; it also sweeps at boot. Default ROOM_GC_INTERVAL_MS (1 h). */
  roomGcIntervalMs?: number;
  /** Seats the last process held at its graceful restart (ADR 0032): kept SEAT_HOLD_MS for their names. */
  seatHolds?: readonly SeatHold[];
}

/** The Bun server, plus what the process's lifecycle needs (OME-504). */
export interface OmegaServer extends Server<ConnData> {
  /** Prometheus text for `GET /metrics` (served by `startMetrics` on its own loopback port). */
  metricsText(): string;
  /**
   * Graceful restart: stops accepting, closes every socket with SERVICE_RESTART (clients reconnect on
   * their own) and resolves, once they are closed, with the seats held, for the store to keep.
   */
  drain(): Promise<SeatHold[]>;
}

/** How long `drain` waits for clients to answer the close before cutting them off. */
const DRAIN_GRACE_MS = 3000;

/** The slice of RoomStore the server uses. */
export type RoomPersistence = Pick<
  RoomStore,
  | "listRooms"
  | "createRoom"
  | "deleteRoom"
  | "setEmbed"
  | "setLayout"
  | "setTitle"
  | "setLastActive"
  | "setControlPolicy"
  | "addQueueItem"
  | "removeQueueItem"
  | "advanceQueue"
>;

/** Whitespace, punctuation and symbols: `bad word` and `b.a.d-w_o r d` match a blocklisted `badword` (OME-439). */
const SEPARATORS = /[\p{Z}\p{P}\p{S}\s]/gu;
const blockKey = (text: string): string => nicknameKey(text).replace(SEPARATORS, "");

/** Folds case and lookalikes (UTS #39 skeleton, ADR 0022) so "BADW0RD" matches "badword", and drops separators. */
function titleBlocker(terms: readonly string[]): (title: string) => boolean {
  const keys = terms.map(blockKey).filter((key) => key !== "");
  if (keys.length === 0) return () => false;
  return (title) => {
    if (title === "") return false;
    const key = blockKey(title);
    return keys.some((k) => key.includes(k));
  };
}

/**
 * Every stored room, plus the configured ones the store lacks, seeded with DEFAULT_LAYOUT. A stored
 * embed the policy no longer accepts (GENERIC_EMBEDS=off, a newly denied host) comes back as null;
 * the row keeps it, so switching back restores it. Queue items get the same treatment. A restored current item
 * counts as current from `since` (monotonic), so `ended` waits out the debounce again (ADR 0031 §4).
 */
function loadRooms(
  rooms: RoomRegistry,
  configured: readonly RoomId[],
  store: RoomPersistence | null,
  embeds: EmbedPolicy,
  now: number,
  since: number,
): void {
  if (store !== null) {
    for (const r of store.listRooms()) {
      const embed = embeds.restore(r.embed);
      // Items the policy no longer accepts are left out; their rows stay, as for the embed.
      const restored = r.queue.flatMap((i) => {
        const again = embeds.restore(i.embed);
        return again === null || i.id === r.itemId ? [] : [{ id: i.id, embed: again }];
      });
      // Hidden rows don't count toward QUEUE_MAX while hidden, so a flip back can bring more: keep the oldest.
      if (restored.length > QUEUE_MAX) logError("store.queue", new Error(`restored queue over QUEUE_MAX: ${String(restored.length - QUEUE_MAX)} items left out`));
      const queue = restored.slice(0, QUEUE_MAX);
      rooms.addRoom(new Room(r.id, { ...r, embed, itemId: embed === null ? null : r.itemId, queue, itemSince: since }));
    }
  }
  for (const id of configured) {
    if (rooms.get(id) !== undefined) continue;
    store?.createRoom({ id, title: "", createdAt: now, layout: DEFAULT_LAYOUT });
    rooms.addRoom(new Room(id, { createdAt: now }));
  }
}

const WS_PATH = /^\/rooms\/([^/]+)\/ws$/;
/** Any Chromium extension id, unless `extensionIds` (EXTENSION_IDS) pins the published ones. */
const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;

export function startServer(opts: ServerOptions): OmegaServer {
  const trustProxy = opts.trustProxy ?? false;
  const maxConnectionsPerIp = opts.maxConnectionsPerIp ?? (trustProxy ? 10 : 50);
  const maxConnections = opts.maxConnections ?? 200;
  let connections = 0;
  const store = opts.store ?? null;
  const wallNow = opts.wallNow ?? Date.now;
  const embeds = new EmbedPolicy({
    genericEmbeds: opts.genericEmbeds ?? true,
    ownHosts: opts.ownHosts ?? ownHostsFor(opts.siteOrigin, opts.publicOrigin ?? null),
    denylist: opts.genericEmbedDenylist ?? [],
  });
  const headers = securityHeaders(embeds.genericEmbeds);
  const plain = (status: number, text: string): Response => plainWith(status, text, headers);
  const rooms = opts.registry ?? new RoomRegistry();
  loadRooms(rooms, opts.rooms ?? [DEFAULT_ROOM_ID], store, embeds, wallNow(), (opts.now ?? monotonic)());
  for (const room of rooms.values()) {
    const held = opts.seatHolds?.filter((h) => h.roomId === room.id) ?? [];
    if (held.length > 0) room.holdSeats(held, wallNow() + SEAT_HOLD_MS);
  }
  const metrics = new Metrics();
  const connectionsPerIp = new Map<string, number>();

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

  const persistEmbed = (room: Room, embed: AnyEmbed, itemId: QueueItemId): void => {
    store?.setEmbed(room.id, embed, itemId);
  };
  const queue = createQueue({ rooms, embeds, publish, store, now: opts.now ?? monotonic });

  const titleBlocked = titleBlocker(opts.roomTitleBlocklist ?? []);

  /** Room GC's clock: memory first, so a failed write can only make GC late (the row keeps an older time), never lose the room. */
  const markActive = (room: Room, at: number): void => {
    room.lastActiveAt = at;
    try {
      store?.setLastActive(room.id, at);
    } catch (err) {
      logError("store.last_active", err);
    }
  };

  const ws = createWs({
    queue,
    joinTimeoutMs: opts.joinTimeoutMs ?? 10_000,
    rooms,
    publish,
    headers,
    persistLayout(room, layout) {
      store?.setLayout(room.id, layout);
    },
    persistTitle(room, title) {
      store?.setTitle(room.id, title);
    },
    persistControlPolicy(room, policy) {
      store?.setControlPolicy(room.id, policy);
    },
    titleBlocked,
    now: opts.now ?? monotonic,
    metrics,
    wallNow,
    occupancyChanged: (room) => {
      markActive(room, wallNow());
    },
    ...(opts.statusIntervalMs === undefined ? {} : { statusIntervalMs: opts.statusIntervalMs }),
    release(ip) {
      connections--;
      const left = (connectionsPerIp.get(ip) ?? 1) - 1;
      if (left === 0) connectionsPerIp.delete(ip);
      else connectionsPerIp.set(ip, left);
    },
  });
  // After createWs's hook: a removed room's sockets close with ROOM_CLOSED and their share grants
  // are revoked before its row is deleted (ADR 0028 §2). GC and the operator end here; an owner's
  // delete has already removed the row (`unpersistRoom`), so this is a no-op for it.
  rooms.onRemove((room) => {
    try {
      store?.deleteRoom(room.id);
    } catch (err) {
      // The room is gone from memory; its row comes back at the next boot, where GC or the operator can end it.
      logError("store.delete_room", err);
    }
  });
  const app = createHttpApp({
    queue,
    rooms,
    persistRoom: (room) => {
      store?.createRoom(room);
    },
    unpersistRoom: (room) => {
      store?.deleteRoom(room.id);
    },
    titleBlocked,
    wallNow,
    shareGrant: ws.shareGrant,
    now: opts.now ?? monotonic,
    isAllowedOrigin,
    ipOf,
    publish,
    persistEmbed,
    embeds,
    headers,
    staticDir: opts.staticDir ?? null,
  });
  // After the onRemove hooks above, so the boot sweep already closes sockets and deletes rows.
  const gc = startRoomGc({ rooms, wallNow, busy: ws.hasSockets, touch: markActive, intervalMs: opts.roomGcIntervalMs ?? ROOM_GC_INTERVAL_MS });
  const http = createHttpGate((req) => app.fetch(req), {
    now: opts.now ?? monotonic,
    maxInFlight: opts.maxHttpInFlight ?? MAX_HTTP_IN_FLIGHT,
    headers,
  });

  /** HSTS goes only to the https public host: never to loopback names, plain http or localhost dev (research M4 D1). */
  const publicUrl = opts.publicOrigin == null ? null : new URL(opts.publicOrigin);
  const hstsHost = publicUrl?.protocol === "https:" ? publicUrl.host : null;
  const withHsts = (res: Response): Response => {
    res.headers.set("strict-transport-security", HSTS);
    return res;
  };

  const route = (req: Request, srv: Server<ConnData>): Response | Promise<Response> | undefined => {
    // Before routing, for HTTP and upgrades alike (ADR 0015 §4).
    if (!hostOk(req)) return plain(421, "misdirected request");
    // Not a ShareResponse: the contract has no code for it, and only a hostile page can trigger it.
    if (!originOk(req)) return plain(403, "forbidden origin");
    // Cheap test first so ordinary HTTP requests skip URL parsing.
    if (!req.url.includes("/ws")) return http(req, ipOf(req));
    const match = WS_PATH.exec(new URL(req.url).pathname);
    if (match === null) return http(req, ipOf(req));
    const ip = ipOf(req);
    // Before the lookup, so probing for room ids costs a token like a real upgrade (threat model S5).
    const refused = ws.admitUpgrade(ip);
    if (refused !== null) return refused;
    const room = rooms.get(match[1] ?? "");
    if (room === undefined) return plain(404, "unknown room");
    if (connections >= maxConnections) return plain(503, "server full");
    const open = connectionsPerIp.get(ip) ?? 0;
    if (open >= maxConnectionsPerIp) return plain(429, "too many connections");
    if (!srv.upgrade(req, { data: ws.connData(room, ip) })) return plain(426, "expected a WebSocket upgrade");
    connectionsPerIp.set(ip, open + 1);
    connections++;
    return undefined;
  };

  const bunServer: Server<ConnData> = Bun.serve<ConnData>({
    port: opts.port,
    hostname: opts.hostname ?? "127.0.0.1",
    maxRequestBodySize: 64 * 1024,
    fetch(req, srv) {
      const res = route(req, srv);
      if (res === undefined || hstsHost === null || req.headers.get("host")?.toLowerCase() !== hstsHost) return res;
      return res instanceof Promise ? res.then(withHsts) : withHsts(res);
    },
    websocket: ws.websocket,
  });
  const server = Object.assign(bunServer, {
    metricsText: () => {
      let members = 0;
      for (const room of rooms.values()) members += room.memberCount;
      return metrics.render({ rooms: rooms.size, sockets: connections, members });
    },
    drain: async () => {
      const holds: SeatHold[] = [];
      for (const room of rooms.values()) for (const h of room.heldSeats()) holds.push({ roomId: room.id, ...h });
      // Stop listening first, so nothing joins between the snapshot of seats and the closes.
      const closed = server.stop(false);
      ws.closeAll();
      await Promise.race([closed, Bun.sleep(DRAIN_GRACE_MS)]);
      await server.stop(true);
      return holds;
    },
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
  // Stopping the server stops its GC too, so a stopped server's store is never swept again.
  const stopServer = server.stop.bind(server);
  server.stop = (closeActiveConnections?: boolean) => {
    gc.stop();
    return stopServer(closeActiveConnections);
  };
  return server;
}
