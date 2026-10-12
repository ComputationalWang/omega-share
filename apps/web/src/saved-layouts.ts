import * as v from "valibot";
import { RoomLayoutSchema, type RoomLayout } from "@omega/shared";

// The owner's own saved layouts (OME-910): up to five named layouts in localStorage, offered when creating a room.
// localStorage is untrusted (anyone can edit it, privacy mode can make it throw): every read is parsed with the shared
// RoomLayoutSchema, invalid entries are dropped, and nothing here ever throws.

export const SAVED_LAYOUTS_KEY = "omega.savedLayouts.v1";
export const MAX_SAVED_LAYOUTS = 5;
export const SAVED_LAYOUT_NAME_MAX = 40;

export interface SavedLayout {
  readonly name: string;
  readonly layout: RoomLayout;
}

export interface LayoutStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type SaveResult =
  | { readonly ok: true; /** The name that fell off to make room, if any. */ readonly dropped: string | null }
  | { readonly ok: false; readonly reason: "name" | "layout" | "storage" };

const NameSchema = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(SAVED_LAYOUT_NAME_MAX));
const EntrySchema = v.object({ name: NameSchema, layout: RoomLayoutSchema });

export function loadSavedLayouts(store: Pick<LayoutStore, "getItem">): SavedLayout[] {
  try {
    const raw = store.getItem(SAVED_LAYOUTS_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: SavedLayout[] = [];
    for (const item of parsed as unknown[]) {
      const r = v.safeParse(EntrySchema, item);
      if (r.success && !out.some((o) => o.name === r.output.name)) out.push(r.output);
      if (out.length === MAX_SAVED_LAYOUTS) break;
    }
    return out;
  } catch {
    return [];
  }
}

function write(store: LayoutStore, list: readonly SavedLayout[]): boolean {
  try {
    store.setItem(SAVED_LAYOUTS_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

/** The same (trimmed) name overwrites in place; a sixth name drops the oldest, and says which. */
export function saveLayout(store: LayoutStore, name: string, layout: RoomLayout): SaveResult {
  const n = v.safeParse(NameSchema, name);
  if (!n.success) return { ok: false, reason: "name" };
  const l = v.safeParse(RoomLayoutSchema, layout);
  if (!l.success) return { ok: false, reason: "layout" };
  const list = loadSavedLayouts(store);
  const at = list.findIndex((s) => s.name === n.output);
  let dropped: string | null = null;
  if (at >= 0) list[at] = { name: n.output, layout: l.output };
  else {
    list.push({ name: n.output, layout: l.output });
    if (list.length > MAX_SAVED_LAYOUTS) dropped = list.shift()?.name ?? null;
  }
  return write(store, list) ? { ok: true, dropped } : { ok: false, reason: "storage" };
}

export function deleteSavedLayout(store: LayoutStore, name: string): void {
  const list = loadSavedLayouts(store);
  const next = list.filter((s) => s.name !== name);
  if (next.length !== list.length) write(store, next);
}
