import { DEFAULT_ROOM_ID, RoomListResponseSchema } from "@omega/shared";
import * as v from "valibot";

export interface RoomOption {
  readonly id: string;
  readonly label: string;
}

export interface RoomList {
  readonly rooms: readonly RoomOption[];
  readonly selected: string;
}

export interface LoadRoomsOptions {
  readonly baseUrl: string;
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
}

/** The default room alone: shown before `GET /rooms` answers and whenever it fails. */
export const FALLBACK_ROOMS: RoomList = { rooms: [{ id: DEFAULT_ROOM_ID, label: DEFAULT_ROOM_ID }], selected: DEFAULT_ROOM_ID };

/** `GET {baseUrl}/rooms`, parsed against the contract. Any failure or an empty list yields the default room alone; never throws. */
export async function loadRooms({ baseUrl, fetch }: LoadRoomsOptions): Promise<RoomList> {
  let json: unknown;
  try {
    const response = await fetch(`${baseUrl}/rooms`, { method: "GET" });
    // Non-2xx bodies (e.g. the 403 for a foreign origin) are plain text.
    if (!response.ok) return FALLBACK_ROOMS;
    json = await response.json();
  } catch {
    return FALLBACK_ROOMS;
  }

  const parsed = v.safeParse(RoomListResponseSchema, json);
  if (!parsed.success) return FALLBACK_ROOMS;
  const [first] = parsed.output.rooms;
  if (first === undefined) return FALLBACK_ROOMS;
  const rooms = parsed.output.rooms.map((r) => ({ id: r.id, label: `${r.id} (${String(r.memberCount)})` }));
  return { rooms, selected: rooms.some((r) => r.id === DEFAULT_ROOM_ID) ? DEFAULT_ROOM_ID : first.id };
}
