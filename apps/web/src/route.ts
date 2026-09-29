import * as v from "valibot";
import { DEFAULT_ROOM_ID, RoomIdSchema, type RoomId } from "@omega/shared";

/** `/r/<room>` → room id; anything else (or an invalid id) → the default room. */
export function roomIdFromPath(pathname: string): RoomId {
  const m = /^\/r\/([^/]+)\/?$/.exec(pathname);
  const r = v.safeParse(RoomIdSchema, m?.[1]);
  return r.success ? r.output : DEFAULT_ROOM_ID;
}

export function wsUrl(serverUrl: string, roomId: RoomId): string {
  const url = new URL(serverUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`server URL must be http(s): ${serverUrl}`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/rooms/${roomId}/ws`;
  url.search = "";
  url.hash = "";
  return url.href;
}
