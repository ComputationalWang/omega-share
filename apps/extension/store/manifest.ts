import * as v from "valibot";

/** Web Store upload limit we hold ourselves to (OME-509). Today's package is a few tens of KB. */
export const STORE_ZIP_MAX_BYTES = 500 * 1024;

/** ADR 0005 and R1: the only API permissions, and the optional hosts `parseServerBaseUrl` can ever ask for. */
export const STORE_PERMISSIONS = ["activeTab", "scripting", "storage"] as const;
export const STORE_OPTIONAL_HOST_PERMISSIONS = ["https://*/*", "http://localhost/*", "http://127.0.0.1/*", "http://[::1]/*"] as const;
const ICON_SIZES = ["16", "32", "48", "128"] as const;

export type StoreBrowser = "chrome" | "firefox";
/** OME-593, decisions on OME-546: the AMO add-on ID is permanent, and these values are fixed with it. */
export const GECKO_ID = "omega-share@omega-share.duckdns.org";
export const GECKO_STRICT_MIN_VERSION = "140.0";
export const GECKO_DATA_COLLECTION = ["websiteContent", "browsingActivity"] as const;
/** Exactly one https origin: the hosted server. No wildcard host, no path. */
const HOSTED_ORIGIN_PATTERN = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+\/\*$/;

const StringList = v.array(v.string());
const ManifestSchema = v.looseObject({
  version: v.string(),
  permissions: v.optional(StringList, []),
  host_permissions: v.optional(StringList, []),
  optional_host_permissions: v.optional(StringList, []),
  icons: v.optional(v.record(v.string(), v.string()), {}),
  background: v.optional(v.looseObject({ service_worker: v.optional(v.string()), persistent: v.optional(v.boolean()), scripts: v.optional(StringList) })),
  options_ui: v.optional(v.looseObject({ open_in_tab: v.optional(v.boolean()) })),
  browser_specific_settings: v.optional(
    v.looseObject({
      gecko: v.optional(
        v.looseObject({
          id: v.optional(v.string()),
          strict_min_version: v.optional(v.string()),
          data_collection_permissions: v.optional(v.looseObject({ required: v.optional(StringList), optional: v.optional(StringList) })),
        }),
      ),
    }),
  ),
});
type Manifest = v.InferOutput<typeof ManifestSchema>;

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The packaging guard: what a built `manifest.json` must look like before it may be zipped for the store.
 * It is what stops the e2e build (extra localhost and YouTube host permissions) from ever shipping.
 * Returns the problems found; empty means it may ship.
 */
export function checkStoreManifest(manifest: unknown, version: string, browser: StoreBrowser = "chrome"): string[] {
  const parsed = v.safeParse(ManifestSchema, manifest);
  if (!parsed.success) return ["manifest: not a manifest.json object with a version"];
  const m = parsed.output;
  const raw = typeof manifest === "object" && manifest !== null ? manifest : {};
  const problems: string[] = [];
  if (m.version !== version) problems.push(`version: ${m.version} is not package.json's ${version}`);
  if (!sameList(m.permissions, STORE_PERMISSIONS)) problems.push(`permissions: ${JSON.stringify(m.permissions)}, expected ${JSON.stringify(STORE_PERMISSIONS)}`);
  if (m.host_permissions.length !== 1 || !m.host_permissions.every((p) => HOSTED_ORIGIN_PATTERN.test(p))) {
    problems.push(`host_permissions: ${JSON.stringify(m.host_permissions)}, expected exactly the hosted https origin (is this the e2e build?)`);
  }
  if (!sameList(m.optional_host_permissions, STORE_OPTIONAL_HOST_PERMISSIONS)) {
    problems.push(`optional_host_permissions: ${JSON.stringify(m.optional_host_permissions)}, expected ${JSON.stringify(STORE_OPTIONAL_HOST_PERMISSIONS)}`);
  }
  if ("optional_permissions" in raw) problems.push("optional_permissions: none allowed");
  if ("content_scripts" in raw) problems.push("content_scripts: none allowed (the scan is injected only when the popup opens)");
  problems.push(...(browser === "firefox" ? firefoxProblems(m) : chromeProblems(m)));
  const missing = ICON_SIZES.filter((size) => m.icons[size] === undefined);
  if (missing.length > 0) problems.push(`icons: missing ${missing.join(", ")} px`);
  return problems;
}

function chromeProblems(m: Manifest): string[] {
  const problems: string[] = [];
  if (m.background !== undefined && (m.background.service_worker === undefined || m.background.persistent !== undefined || m.background.scripts !== undefined)) {
    problems.push("background: only a non-persistent service_worker is allowed");
  }
  if (m.browser_specific_settings !== undefined) problems.push("browser_specific_settings: Firefox only, not in the Chrome build");
  return problems;
}

/** Firefox MV3 has no service worker: the background is a non-persistent event page (`scripts`, no `persistent`). */
function firefoxProblems(m: Manifest): string[] {
  const problems: string[] = [];
  if (m.background !== undefined && (m.background.scripts === undefined || m.background.persistent !== undefined || m.background.service_worker !== undefined)) {
    problems.push("background: only a non-persistent event page (scripts) is allowed");
  }
  const settings = m.browser_specific_settings;
  const gecko = settings?.gecko;
  if (gecko?.id !== GECKO_ID) problems.push(`browser_specific_settings.gecko.id: ${String(gecko?.id)}, expected the permanent ${GECKO_ID}`);
  if (gecko?.strict_min_version !== GECKO_STRICT_MIN_VERSION) {
    problems.push(`browser_specific_settings.gecko.strict_min_version: ${String(gecko?.strict_min_version)}, expected ${GECKO_STRICT_MIN_VERSION}`);
  }
  const collection = gecko?.data_collection_permissions;
  if (collection === undefined || !sameList(collection.required ?? [], GECKO_DATA_COLLECTION) || collection.optional !== undefined) {
    problems.push(`browser_specific_settings.gecko.data_collection_permissions: ${JSON.stringify(collection)}, expected required ${JSON.stringify(GECKO_DATA_COLLECTION)} only`);
  }
  if (settings !== undefined && "gecko_android" in settings) problems.push("browser_specific_settings.gecko_android: desktop only");
  if (m.options_ui?.open_in_tab !== true) problems.push("options_ui.open_in_tab: must be true (not embedded in about:addons)");
  return problems;
}
