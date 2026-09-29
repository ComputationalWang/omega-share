import { MAX_URL_LENGTH } from "@omega/shared";

/** Local `apps/server` (`PORT` defaults to 8787 in the e2e harness). */
export const DEFAULT_SERVER_BASE_URL = "http://localhost:8787";
export const SERVER_BASE_URL_KEY = "serverBaseUrl";

export type ParsedServerBaseUrl = { readonly ok: true; readonly origin: string } | { readonly ok: false; readonly message: string };

/** The server base URL must be a bare http(s) origin: no credentials, path, query or fragment. */
export function parseServerBaseUrl(input: string): ParsedServerBaseUrl {
  const trimmed = input.trim();
  if (trimmed === "" || trimmed.length > MAX_URL_LENGTH) return { ok: false, message: "Enter a URL like http://localhost:8787." };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, message: "That is not a valid URL." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, message: "Use http:// or https://." };
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

/** Host permission match pattern for exactly this origin. */
export function hostPermissionPattern(origin: string): string {
  return `${origin}/*`;
}
