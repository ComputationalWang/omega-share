import { DEFAULT_SERVER_BASE_URL, SERVER_BASE_URL_KEY, hostPermissionPattern, parseServerBaseUrl } from "./settings";

/** The browser calls the options page makes; injected so failures can be tested. */
export interface SaveDeps {
  /** `permissions.request({ origins: [pattern] })` */
  readonly requestOrigin: (pattern: string) => Promise<boolean>;
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
  set(items: Record<string, unknown>): Promise<void>;
}

/** Binds `SaveDeps` to the real (or a fake) `permissions` and `storage.local`. */
export function browserSaveDeps(permissions: PermissionsLike, storage: StorageLike): SaveDeps {
  return {
    requestOrigin: (pattern) => permissions.request({ origins: [pattern] }),
    store: (origin) => storage.set({ [SERVER_BASE_URL_KEY]: origin }),
    removeOrigin: (pattern) => permissions.remove({ origins: [pattern] }),
  };
}

export type SaveResult = { readonly ok: true; readonly origin: string; readonly message: string } | { readonly ok: false; readonly message: string };

/**
 * Validates and saves a new server base URL. The permission request is made before
 * the first `await`, so it still runs inside the submit's user gesture. The manifest
 * already grants the default origin, so it is never requested or removed.
 */
export function saveServerBaseUrl(input: string, current: string, deps: SaveDeps): Promise<SaveResult> {
  const parsed = parseServerBaseUrl(input);
  if (!parsed.ok) return Promise.resolve(parsed);
  const { origin } = parsed;
  let granted: Promise<boolean>;
  try {
    granted = origin === DEFAULT_SERVER_BASE_URL ? Promise.resolve(true) : deps.requestOrigin(hostPermissionPattern(origin));
  } catch {
    return Promise.resolve(saveFailed(origin));
  }
  return finish(granted, origin, current, deps);
}

async function finish(granted: Promise<boolean>, origin: string, current: string, deps: SaveDeps): Promise<SaveResult> {
  try {
    if (!(await granted)) return { ok: false, message: `Permission to reach ${origin} was not granted.` };
    await deps.store(origin);
  } catch {
    return saveFailed(origin);
  }
  if (current !== origin && current !== DEFAULT_SERVER_BASE_URL) {
    // Best effort: the new origin is saved either way; a leftover grant is harmless.
    await deps.removeOrigin(hostPermissionPattern(current)).catch(() => undefined);
  }
  return { ok: true, origin, message: `Saved. Sharing to ${origin}.` };
}

function saveFailed(origin: string): SaveResult {
  return { ok: false, message: `Could not save ${origin}. Try again.` };
}
