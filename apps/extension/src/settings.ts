import { MAX_URL_LENGTH } from "@omega/shared";

/** Local `apps/server` (`PORT` defaults to 8787 in the e2e harness). */
export const DEFAULT_SERVER_BASE_URL = "http://localhost:8787";
export const SERVER_BASE_URL_KEY = "serverBaseUrl";

export type ParsedServerBaseUrl = { readonly ok: true; readonly origin: string } | { readonly ok: false; readonly message: string };

/** Hosts where cleartext `http:` is allowed; anything else must use `https:`. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The URL parser silently drops tabs and newlines inside a URL; we refuse them instead. */
const INNER_WHITESPACE_OR_CONTROL = /[\s\u0000-\u001f\u007f]/;
/** After parsing, an IPv4 host is always dotted-quad and an IPv6 host is bracketed. */
const IP_LITERAL = /^(\d{1,3}(\.\d{1,3}){3}|\[.*\])$/;

/**
 * The server base URL must be a bare origin: no credentials, path, query or fragment.
 * `http:` only for the local machine; remote servers need `https:` and a name, not an IP
 * (a tunnel always has one, and this refuses "type your LAN IP" mistakes).
 */
export function parseServerBaseUrl(input: string): ParsedServerBaseUrl {
  const trimmed = input.trim();
  if (trimmed === "" || trimmed.length > MAX_URL_LENGTH) return { ok: false, message: "Enter a URL like http://localhost:8787." };
  if (INNER_WHITESPACE_OR_CONTROL.test(trimmed)) return { ok: false, message: "That is not a valid URL." };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, message: "That is not a valid URL." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, message: "Use http:// or https://." };
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) return { ok: false, message: "Use https:// for a server that is not on this computer." };
  if (IP_LITERAL.test(url.hostname) && !LOOPBACK_HOSTS.has(url.hostname)) return { ok: false, message: "Use the server's name, not an IP address." };
  if (url.hostname.endsWith(".") || url.port === "0") return { ok: false, message: "That is not a valid server address." };
  if (url.username !== "" || url.password !== "") return { ok: false, message: "Remove the username and password." };
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "" || trimmed.includes("?") || trimmed.includes("#")) {
    return { ok: false, message: "Use the server origin only, without a path." };
  }
  return { ok: true, origin: url.origin };
}

/** What `chrome.storage` holds, or the default when it is missing or invalid. */
export function readServerBaseUrl(stored: unknown): string {
  if (typeof stored !== "string") return DEFAULT_SERVER_BASE_URL;
  const parsed = parseServerBaseUrl(stored);
  return parsed.ok ? parsed.origin : DEFAULT_SERVER_BASE_URL;
}

/** The hosts that are our own site for `origin` (already parsed): never listed as a generic embed. */
export function ownHostsOf(origin: string): string[] {
  try {
    return [new URL(origin).hostname];
  } catch {
    return [];
  }
}

/** Whether `origin` (already parsed) is this computer. */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/**
 * Sent on every server request. ngrok's free tier shows HTML browser traffic a warning page
 * unless this header is present (research OME-119 §1.4); other servers ignore it.
 */
export const SERVER_REQUEST_HEADERS: Readonly<Record<string, string>> = { "ngrok-skip-browser-warning": "1" };

/**
 * `credentials` carries an edge gate's session cookie; `redirect: "manual"` turns a bounce to a
 * login page into an `opaqueredirect` response instead of a cross-origin fetch.
 */
export const SERVER_REQUEST_INIT = { credentials: "include", redirect: "manual" } as const satisfies RequestInit;

/** Host permission match pattern for exactly this origin. */
export function hostPermissionPattern(origin: string): string {
  return `${origin}/*`;
}
