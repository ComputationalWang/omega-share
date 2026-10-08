import * as v from "valibot";
import { DEFAULT_ROOM_ID, RoomIdSchema, type RoomId } from "@omega/shared";

/** `/r/<room>` → room id; anything else (or an invalid id) → null. */
export function roomIdInPath(pathname: string): RoomId | null {
  const m = /^\/r\/([^/]+)\/?$/.exec(pathname);
  const r = v.safeParse(RoomIdSchema, m?.[1]);
  return r.success ? r.output : null;
}

/** `/r/<room>` → room id; anything else (or an invalid id) → the default room. */
export function roomIdFromPath(pathname: string): RoomId {
  return roomIdInPath(pathname) ?? DEFAULT_ROOM_ID;
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

/**
 * Base URL of apps/server. A built site is served by the server itself, so it uses its own origin and
 * one tunnel covers site, API and WebSocket (ADR 0015 §1). The Vite dev site finds it on port 8787.
 */
export function serverBaseUrl(
  configured: string | undefined,
  location: Pick<Location, "origin" | "protocol" | "hostname">,
  dev: boolean,
): string {
  if (configured !== undefined) return configured;
  return dev ? `${location.protocol}//${location.hostname}:8787` : location.origin;
}
