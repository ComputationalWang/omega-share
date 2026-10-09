import { type RoomId, RoomIdSchema, SHARE_TOKEN_STORAGE_KEY, type ShareToken, ShareTokenRecordSchema } from "@omega/shared";
import * as v from "valibot";
import { isLoopbackOrigin } from "./settings";

/** Room tabs read per popup open; each is one `executeScript`. */
const MAX_TABS = 8;
/** `{"roomId":…,"token":…}` with the longest room id fits well inside this. */
export const MAX_RECORD_LENGTH = 512;

/** The browser calls the popup makes; injected so the flow can be tested. */
export interface TokenDeps {
  /** `tabs.query({ url: patterns })`: only tabs we hold host permission for match. */
  readonly queryTabs: (patterns: string[]) => Promise<readonly { readonly id?: number | undefined; readonly url?: string | undefined }[]>;
  /**
   * One-shot `scripting.executeScript({ target: { tabId }, func, args })`, returning the first frame's result.
   * Only `readRecordInPage` with `SHARE_TOKEN_STORAGE_KEY` is ever injected: the site's room secrets
   * (owner tokens and invite keys) stay unread (ADR 0028).
   */
  readonly inject: (tabId: number, func: typeof readRecordInPage, args: [key: string, max: number]) => Promise<unknown>;
}

/** What the open room tabs say: their rooms in tab order (incl. private ones), and the share tokens found. */
export interface RoomTabs {
  readonly rooms: readonly RoomId[];
  readonly tokens: ReadonlyMap<RoomId, ShareToken>;
}

/**
 * Injected into a room tab by `scripting.executeScript({ func, args: [key, MAX_RECORD_LENGTH] })`,
 * so it must stay self-contained. Oversized values stay in the page: a hostile page can't
 * stall the popup with a multi-MB string being structured-cloned across.
 */
export function readRecordInPage(key: string, max: number, storage: Pick<Storage, "getItem"> = sessionStorage): string | null {
  const value = storage.getItem(key);
  return value !== null && value.length <= max ? value : null;
}

/**
 * Where the site's room pages live. Deployed, the site and server share one origin (ADR 0015).
 * Locally the dev site runs on its own port, so a loopback server matches room pages on any local port.
 */
export function roomTabPatterns(origin: string): string[] {
  if (isLoopbackOrigin(origin)) return ["http://localhost/r/*", "http://127.0.0.1/r/*", "http://[::1]/r/*"];
  // Port-less, like hostPermissionPattern: Firefox never matches a pattern with a port (QA OME-687).
  const { protocol, hostname } = new URL(origin);
  return [`${protocol}//${hostname}/r/*`];
}

/**
 * Lists the rooms open in the user's site tabs, from their `/r/<id>` URLs alone (threat model §3.5),
 * and reads each room tab's share token record (ADR 0015 item 7). A record only counts for the
 * room in its own tab's URL, so a planted record can't shadow another room's token.
 * Hostile or missing records are skipped; never throws.
 */
export async function readRoomTabs(origin: string, deps: TokenDeps): Promise<RoomTabs> {
  let all: { id: number; roomId: RoomId }[];
  try {
    all = (await deps.queryTabs(roomTabPatterns(origin))).flatMap((t) => {
      const roomId = roomIdFromTabUrl(t.url);
      return t.id === undefined || roomId === null ? [] : [{ id: t.id, roomId }];
    });
  } catch {
    return { rooms: [], tokens: new Map() };
  }
  const rooms = [...new Set(all.map((t) => t.roomId))];
  const tabs = all.slice(0, MAX_TABS);
  const read = (tabId: number): Promise<unknown> => deps.inject(tabId, readRecordInPage, [SHARE_TOKEN_STORAGE_KEY, MAX_RECORD_LENGTH]);
  const records = await Promise.all(tabs.map((t) => read(t.id).then(parseRecord, () => null)));
  const tokens = new Map<RoomId, ShareToken>();
  records.forEach((r, i) => {
    if (r !== null && r.roomId === tabs[i]?.roomId && !tokens.has(r.roomId)) tokens.set(r.roomId, r.token);
  });
  return { rooms, tokens };
}

/** The site's `/r/<room>` path (see `apps/web/src/route.ts`), strictly: no default room. */
function roomIdFromTabUrl(url: string | undefined): RoomId | null {
  if (url === undefined || !URL.canParse(url)) return null;
  const m = /^\/r\/([^/]+)\/?$/.exec(new URL(url).pathname);
  const parsed = v.safeParse(RoomIdSchema, m?.[1]);
  return parsed.success ? parsed.output : null;
}

function parseRecord(raw: unknown): { roomId: RoomId; token: ShareToken } | null {
  if (typeof raw !== "string" || raw.length > MAX_RECORD_LENGTH) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = v.safeParse(ShareTokenRecordSchema, json);
  return parsed.success ? parsed.output : null;
}
