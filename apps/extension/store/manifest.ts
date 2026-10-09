import * as v from "valibot";

/** Web Store upload limit we hold ourselves to (OME-509). Today's package is a few tens of KB. */
export const STORE_ZIP_MAX_BYTES = 500 * 1024;

/** ADR 0005 and R1: the only API permissions, and the optional hosts `parseServerBaseUrl` can ever ask for. */
export const STORE_PERMISSIONS = ["activeTab", "scripting", "storage"] as const;
export const STORE_OPTIONAL_HOST_PERMISSIONS = ["https://*/*", "http://localhost/*", "http://127.0.0.1/*", "http://[::1]/*"] as const;
const ICON_SIZES = ["16", "32", "48", "128"] as const;
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
});

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The packaging guard: what a built `manifest.json` must look like before it may be zipped for the store.
 * It is what stops the e2e build (extra localhost and YouTube host permissions) from ever shipping.
 * Returns the problems found; empty means it may ship.
 */
export function checkStoreManifest(manifest: unknown, version: string): string[] {
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
  if (m.background !== undefined && (m.background.service_worker === undefined || m.background.persistent !== undefined || m.background.scripts !== undefined)) {
    problems.push("background: only a non-persistent service_worker is allowed");
  }
  const missing = ICON_SIZES.filter((size) => m.icons[size] === undefined);
  if (missing.length > 0) problems.push(`icons: missing ${missing.join(", ")} px`);
  return problems;
}
