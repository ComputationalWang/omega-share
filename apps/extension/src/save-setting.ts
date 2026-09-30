import { DEFAULT_SERVER_BASE_URL, SERVER_BASE_URL_KEY, hostPermissionPattern, parseServerBaseUrl, readServerBaseUrl } from "./settings";

/** The browser calls the options page makes; injected so failures can be tested. */
export interface SaveDeps {
  /** `permissions.request({ origins: [pattern] })` */
  readonly requestOrigin: (pattern: string) => Promise<boolean>;
  /** The origin in `storage.local` right now: another options tab may have changed it since this one loaded. */
  readonly readStored: () => Promise<string>;
  /** `storage.local.set({ serverBaseUrl: origin })` */
  readonly store: (origin: string) => Promise<void>;
  /** `permissions.remove({ origins: [pattern] })` */
  readonly removeOrigin: (pattern: string) => Promise<unknown>;
}

/** The slice of `browser.permissions` the options page uses. */
export interface PermissionsLike {
  request(permissions: { origins?: string[] }): Promise<boolean>;
  remove(permissions: { origins?: string[] }): Promise<boolean>;
}

/** The slice of `browser.storage.local` the options page uses. */
export interface StorageLike {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

/** Binds `SaveDeps` to the real (or a fake) `permissions` and `storage.local`. */
export function browserSaveDeps(permissions: PermissionsLike, storage: StorageLike): SaveDeps {
  return {
    requestOrigin: (pattern) => permissions.request({ origins: [pattern] }),
    readStored: () => storage.get(SERVER_BASE_URL_KEY).then((items) => readServerBaseUrl(items[SERVER_BASE_URL_KEY])),
    store: (origin) => storage.set({ [SERVER_BASE_URL_KEY]: origin }),
    removeOrigin: (pattern) => permissions.remove({ origins: [pattern] }),
  };
}

export type SaveResult = { readonly ok: true; readonly origin: string; readonly message: string } | { readonly ok: false; readonly message: string };

/**
 * Validates and saves a new server base URL. The permission request is made before
 * the first `await`, so it still runs inside the submit's user gesture. The manifest
 * already grants the default origin, so it is never requested or removed. The grant
 * revoked is the one for the origin stored when the save lands, re-read then, so a
 * second options tab with a stale view can't leave the other tab's grant behind.
 */
export function saveServerBaseUrl(input: string, deps: SaveDeps): Promise<SaveResult> {
  const parsed = parseServerBaseUrl(input);
  if (!parsed.ok) return Promise.resolve(parsed);
  const { origin } = parsed;
  let granted: Promise<boolean>;
  try {
    granted = origin === DEFAULT_SERVER_BASE_URL ? Promise.resolve(true) : deps.requestOrigin(hostPermissionPattern(origin));
  } catch {
    return Promise.resolve(saveFailed(origin));
  }
  return finish(granted, origin, deps);
}

async function finish(granted: Promise<boolean>, origin: string, deps: SaveDeps): Promise<SaveResult> {
  let previous: string | null;
  try {
    if (!(await granted)) return { ok: false, message: `Permission to reach ${origin} was not granted.` };
    previous = await deps.readStored().catch(() => null);
    await deps.store(origin);
  } catch {
    return saveFailed(origin);
  }
  if (previous !== null && previous !== origin && previous !== DEFAULT_SERVER_BASE_URL) {
    // Best effort: the new origin is saved either way; a leftover grant is harmless.
    await deps.removeOrigin(hostPermissionPattern(previous)).catch(() => undefined);
  }
  return { ok: true, origin, message: `Saved. Sharing to ${origin}.` };
}

function saveFailed(origin: string): SaveResult {
  return { ok: false, message: `Could not save ${origin}. Try again.` };
}
