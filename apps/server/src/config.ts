import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Dev default for `DB_PATH`: `apps/server/data/omega.db` (git-ignored), never under a static dir. */
export const DEFAULT_DB_PATH = join(import.meta.dir, "../data/omega.db");

/** Validated startup config (ADR 0015 §3). A bad value throws, naming the variable. */
export interface ServerConfig {
  port: number;
  /** Listen address. Loopback by default: the tunnel agent is the only way in from outside. */
  hostname: string;
  /** Where the dev site runs (Vite), e.g. `http://localhost:5173`. */
  siteOrigin: string;
  /** The tunnel's public `https://` origin, or null when not tunnelled. */
  publicOrigin: string | null;
  /** Trust the rightmost `X-Forwarded-For` entry from a loopback peer (`TRUST_PROXY=loopback`). */
  trustProxy: boolean;
  /** Absolute path of the built site (`apps/web/dist`) to serve on the same origin, or null. */
  staticDir: string | null;
  /** Allowed Chromium extension ids, or null for any. */
  extensionIds: string[] | null;
  /** Absolute path of the SQLite file, or `:memory:` (tests). Never inside `staticDir` (D5). */
  dbPath: string;
}

type Env = Readonly<Record<string, string | undefined>>;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const EXTENSION_ID = /^[a-p]{32}$/;

const fail = (key: string, why: string): never => {
  throw new Error(`invalid ${key}: ${why}`);
};

/** A bare origin: `https:` (or `http:` on loopback when allowed), no credentials, path, query or hash. */
function parseOrigin(key: string, raw: string, httpOnLoopback: boolean): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail(key, "not a URL");
  }
  if (url.username !== "" || url.password !== "") fail(key, "must not contain credentials");
  // URL drops an empty "?" or "#", so check the raw string too.
  if (url.pathname !== "/" || /[?#]/.test(raw)) fail(key, "must be an origin, with no path or query");
  const httpOk = httpOnLoopback && url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !httpOk) fail(key, httpOnLoopback ? "must be https (http only on loopback)" : "must be https");
  return url.origin;
}

/** `path` with symlinks resolved as far as it exists (the DB file itself may not yet). */
function realish(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(path);
  return parent === path ? path : join(realish(parent), basename(path));
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function parseConfig(env: Env): ServerConfig {
  const rawPort = env["PORT"] ?? "8787";
  const port = /^\d{1,5}$/.test(rawPort) ? Number(rawPort) : NaN;
  if (!Number.isInteger(port) || port > 65535) fail("PORT", "must be 0–65535");

  const hostname = env["HOST"] ?? "127.0.0.1";
  if (hostname === "") fail("HOST", "must not be empty");

  const siteOrigin = parseOrigin("SITE_ORIGIN", env["SITE_ORIGIN"] ?? "http://localhost:5173", true);
  const rawPublic = env["PUBLIC_ORIGIN"];
  const publicOrigin = rawPublic === undefined ? null : parseOrigin("PUBLIC_ORIGIN", rawPublic, false);

  const rawTrust = env["TRUST_PROXY"] ?? "off";
  if (rawTrust !== "loopback" && rawTrust !== "off") fail("TRUST_PROXY", "must be loopback or off");

  const rawStatic = env["STATIC_DIR"];
  let staticDir: string | null = null;
  if (rawStatic !== undefined) {
    staticDir = resolve(rawStatic);
    if (!existsSync(join(staticDir, "index.html"))) fail("STATIC_DIR", "has no index.html (run the site build first)");
  }

  const rawIds = env["EXTENSION_IDS"];
  let extensionIds: string[] | null = null;
  if (rawIds !== undefined) {
    extensionIds = rawIds.split(",").map((s) => s.trim());
    if (extensionIds.some((id) => !EXTENSION_ID.test(id))) fail("EXTENSION_IDS", "expected comma-separated extension ids");
  }

  const rawDb = env["DB_PATH"] ?? DEFAULT_DB_PATH;
  if (rawDb === "") fail("DB_PATH", "must not be empty");
  const dbPath = rawDb === ":memory:" ? rawDb : resolve(rawDb);
  // serveStatic must never be able to hand out the database.
  if (staticDir !== null && dbPath !== ":memory:") {
    const site = realish(staticDir);
    if (isInside(dbPath, staticDir) || isInside(realish(dbPath), site)) fail("DB_PATH", "must not be inside STATIC_DIR");
  }

  return { port, hostname, siteOrigin, publicOrigin, trustProxy: rawTrust === "loopback", staticDir, extensionIds, dbPath };
}
