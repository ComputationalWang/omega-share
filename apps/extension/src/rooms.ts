import { DEFAULT_ROOM_ID, RoomListResponseSchema } from "@omega/shared";
import * as v from "valibot";
import { SERVER_REQUEST_HEADERS, SERVER_REQUEST_INIT } from "./settings";

export interface RoomOption {
  readonly id: string;
  readonly label: string;
}

export interface RoomList {
  readonly rooms: readonly RoomOption[];
  readonly selected: string;
}

/**
 * What one `GET /rooms` says about the server (research OME-119 §5.4):
 * `unreachable` the fetch threw (DNS, TLS, refused), `offline` it answered off the contract
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
    const response = await fetch(`${baseUrl}/rooms`, { method: "GET", headers: SERVER_REQUEST_HEADERS, ...SERVER_REQUEST_INIT });
    if (response.type === "opaqueredirect" || response.status === 401) return { kind: "sign-in" };
    // Non-2xx bodies (e.g. the 403 for a foreign origin, ngrok's offline page) aren't on the contract.
    if (!response.ok) return { kind: "offline" };
    json = await response.json();
  } catch (error) {
    // `json()` rejects with a SyntaxError; a failed fetch rejects with a TypeError.
    return { kind: error instanceof SyntaxError ? "offline" : "unreachable" };
  }

  const parsed = v.safeParse(RoomListResponseSchema, json);
  if (!parsed.success) return { kind: "offline" };
  const [first] = parsed.output.rooms;
  if (first === undefined) return { kind: "ok", list: FALLBACK_ROOMS };
  const rooms = parsed.output.rooms.map((r) => ({ id: r.id, label: `${r.id} (${String(r.memberCount)})` }));
  return { kind: "ok", list: { rooms, selected: rooms.some((r) => r.id === DEFAULT_ROOM_ID) ? DEFAULT_ROOM_ID : first.id } };
}
