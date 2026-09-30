import { type RoomId, type ShareToken, ShareTokenRecordSchema } from "@omega/shared";
import * as v from "valibot";
import { isLoopbackOrigin } from "./settings";

/** Room tabs read per popup open; each is one `executeScript`. */
const MAX_TABS = 8;
/** `{"roomId":…,"token":…}` with the longest room id fits well inside this. */
export const MAX_RECORD_LENGTH = 512;

/** The browser calls the popup makes; injected so the flow can be tested. */
export interface TokenDeps {
  /** `tabs.query({ url: patterns })`: only tabs we hold host permission for match. */
  readonly queryTabs: (patterns: string[]) => Promise<readonly { readonly id?: number | undefined }[]>;
  /** One-shot `scripting.executeScript` that returns `sessionStorage["omega.share"]`, unparsed. */
  readonly readSession: (tabId: number) => Promise<unknown>;
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
  return [`${origin}/r/*`];
}

/** Reads each open room tab's share token record (ADR 0015 item 7). Hostile or missing records are skipped; never throws. */
export async function readShareTokens(origin: string, deps: TokenDeps): Promise<ReadonlyMap<RoomId, ShareToken>> {
  let tabIds: number[];
  try {
    tabIds = (await deps.queryTabs(roomTabPatterns(origin))).flatMap((t) => (t.id === undefined ? [] : [t.id])).slice(0, MAX_TABS);
  } catch {
    return new Map();
  }
  const records = await Promise.all(tabIds.map((id) => deps.readSession(id).then(parseRecord, () => null)));
  const tokens = new Map<RoomId, ShareToken>();
  for (const r of records) if (r !== null && !tokens.has(r.roomId)) tokens.set(r.roomId, r.token);
  return tokens;
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
