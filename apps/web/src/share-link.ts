import { MAX_URL_LENGTH } from "@omega/shared";

// The extension's hand-off when you have no room yet (OME-1085, ADR 0049): it opens `/#share=<encodeURIComponent(url)>`.
// A fragment, so the link never reaches a server log. Only the decode lives here (main chunk); the lazy home chunk
// parses it with the queue's own parser (pending-layout.ts `shareableLink`).

/** Boot step: reads `#share=` once and drops it with replaceState. Malformed, empty or oversized reads as null. */
export function takeShareLink(loc: Pick<Location, "hash" | "pathname" | "search">, history: Pick<History, "replaceState" | "state">): string | null {
  const hash = loc.hash;
  if (!hash.startsWith("#share=")) return null;
  history.replaceState(history.state, "", loc.pathname + loc.search);
  try {
    const url = decodeURIComponent(hash.slice("#share=".length));
    return url === "" || url.length > MAX_URL_LENGTH ? null : url;
  } catch {
    return null;
  }
}
