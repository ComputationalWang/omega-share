import { type AnyEmbed, DEFAULT_ROOM_ID, type NowPlaying, RoomListResponseSchema, nowPlayingOf } from "@omega/shared";
import * as v from "valibot";
import { ROOMS_TIMEOUT_MS, withTimeout } from "./request-timeout";
import { SERVER_REQUEST_HEADERS, SERVER_REQUEST_INIT } from "./settings";

export interface RoomOption {
  readonly id: string;
  readonly label: string;
  /** What `GET /rooms` said (OME-1637); a room known only from a tab has none of these. */
  readonly title?: string;
  /** Members watching: `watchingCount`, or `memberCount` from a server before ADR 0056. */
  readonly watching?: number;
  readonly nowPlaying?: NowPlaying;
}

export interface RoomList {
  readonly rooms: readonly RoomOption[];
  readonly selected: string;
}

/**
 * What one `GET /rooms` says about the server (research OME-119 §5.4):
 * `unreachable` the fetch threw (DNS, TLS, refused) or got no answer within 8 s, `offline` it answered off the contract
 * (non-2xx, or ngrok's HTML error page), `sign-in` an edge gate answered 401 or redirected.
 */
export type RoomsProbe = { readonly kind: "ok"; readonly list: RoomList } | { readonly kind: "unreachable" | "offline" | "sign-in" };

export interface LoadRoomsOptions {
  readonly baseUrl: string;
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
}

/** The default room alone: shown before `GET /rooms` answers, whenever it fails, and for an empty list. */
export const FALLBACK_ROOMS: RoomList = { rooms: [{ id: DEFAULT_ROOM_ID, label: DEFAULT_ROOM_ID }], selected: DEFAULT_ROOM_ID };

/** `GET {baseUrl}/rooms`, parsed against the contract; never throws. */
export async function loadRooms({ baseUrl, fetch }: LoadRoomsOptions): Promise<RoomsProbe> {
  let json: unknown;
  try {
    const reply = await withTimeout(ROOMS_TIMEOUT_MS, async (signal) => {
      const response = await fetch(`${baseUrl}/rooms`, { method: "GET", headers: SERVER_REQUEST_HEADERS, ...SERVER_REQUEST_INIT, signal });
      if (response.type === "opaqueredirect" || response.status === 401) return { kind: "sign-in" } as const;
      // Non-2xx bodies (e.g. the 403 for a foreign origin, ngrok's offline page) aren't on the contract.
      if (!response.ok) return { kind: "offline" } as const;
      return { kind: "json", json: (await response.json()) as unknown } as const;
    });
    if (reply.kind !== "json") return reply;
    json = reply.json;
  } catch (error) {
    // `json()` rejects with a SyntaxError; a failed fetch rejects with a TypeError, a timeout with RequestTimeoutError.
    return { kind: error instanceof SyntaxError ? "offline" : "unreachable" };
  }

  const parsed = v.safeParse(RoomListResponseSchema, json);
  if (!parsed.success) return { kind: "offline" };
  const [first] = parsed.output.rooms;
  if (first === undefined) return { kind: "ok", list: FALLBACK_ROOMS };
  const rooms = parsed.output.rooms.map((r) => ({
    id: r.id,
    label: `${r.title ?? r.id} (${String(r.memberCount)})`,
    ...(r.title === undefined ? {} : { title: r.title }),
    watching: r.watchingCount ?? r.memberCount,
    ...(r.nowPlaying === undefined ? {} : { nowPlaying: r.nowPlaying }),
  }));
  return { kind: "ok", list: { rooms, selected: rooms.some((r) => r.id === DEFAULT_ROOM_ID) ? DEFAULT_ROOM_ID : first.id } };
}

/**
 * The dropdown: rooms open in the user's site tabs first, then the listed ones (threat model §3.5).
 * Tab rooms include private rooms, which `GET /rooms` never lists; a listed one keeps its title label.
 * Pre-selects the first tab room holding a share token, else the first tab room: that's where the user can share.
 */
export function withRoomTabs(list: RoomList, tabs: { readonly rooms: readonly string[]; readonly tokens: ReadonlyMap<string, string> }): RoomList {
  const [first] = tabs.rooms;
  if (first === undefined) return list;
  const open = tabs.rooms.map((id) => list.rooms.find((r) => r.id === id) ?? { id, label: id });
  const rest = list.rooms.filter((r) => !tabs.rooms.includes(r.id));
  return { rooms: [...open, ...rest], selected: tabs.rooms.find((id) => tabs.tokens.has(id)) ?? first };
}

/**
 * "They're already watching this" (OME-1637): rooms whose `nowPlaying` is a video on the page move first, labelled
 * "N watching · Join". The match runs on what the popup already has: nothing about the page goes to the server.
 */
export function withWatching(list: RoomList, embeds: readonly AnyEmbed[]): RoomList {
  const playing = new Set(embeds.flatMap((e) => {
    const n = nowPlayingOf(e);
    return n === undefined ? [] : [`${n.provider}:${n.id}`];
  }));
  const matches = (r: RoomOption): boolean => r.nowPlaying !== undefined && playing.has(`${r.nowPlaying.provider}:${r.nowPlaying.id}`);
  const first = list.rooms.filter(matches).map((r) => ({ ...r, label: `${r.title ?? r.id} · ${String(r.watching ?? 0)} watching · Join` }));
  return first.length === 0 ? list : { ...list, rooms: [...first, ...list.rooms.filter((r) => !matches(r))] };
}

/** The tab badge after a share into `roomId` (OME-1637): its watcher count, or "" (no badge) when there's none to show. */
export function watchingBadge(list: RoomList, roomId: string): string {
  const n = list.rooms.find((r) => r.id === roomId)?.watching ?? 0;
  return n > 0 ? String(n) : "";
}

/** The "New room…" option's value; no room id is empty. */
export const NEW_ROOM = "";

/**
 * Appends "New room…" (OME-1086). It's preselected unless the probe answered and a listed room holds a share token:
 * without one there's no room the user can share into.
 */
export function withNewRoom(list: RoomList, probe: RoomsProbe, tokens: ReadonlyMap<string, string>): RoomList {
  const canShare = probe.kind === "ok" && list.rooms.some((r) => tokens.has(r.id));
  return { rooms: [...list.rooms, { id: NEW_ROOM, label: "New room…" }], selected: canShare ? list.selected : NEW_ROOM };
}

/** The site's home with the video carried along in the fragment (ADR 0049); `origin` is the parsed server base URL. */
export function newRoomUrl(origin: string, url: string): string {
  return `${origin}/#share=${encodeURIComponent(url)}`;
}

/**
 * The room shared into last (OME-1287), selected while the dropdown lists it and it holds a share token: without one it
 * can't be shared into, and the room tab that has one wins. `stored` is the raw storage value.
 */
export function withLastRoom(list: RoomList, stored: unknown, tokens: ReadonlyMap<string, string>): RoomList {
  return typeof stored === "string" && tokens.has(stored) && list.rooms.some((r) => r.id === stored) ? { ...list, selected: stored } : list;
}

/** The storage key for `withLastRoom`. */
export const LAST_ROOM_KEY = "lastRoom";

/** The room on the site (`apps/web/src/route.ts`); `origin` is the parsed server base URL. */
export function roomUrl(origin: string, id: string): string {
  return new URL(`/r/${encodeURIComponent(id)}`, origin).href;
}
