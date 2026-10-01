/** What the page scan found. `urls` feed the synced tier, `media` the generic tier (ADR 0024). */
export interface PageScan {
  /** The page URL, then every iframe/embed/object source. */
  urls: string[];
  /** Iframe and `<video>` (or `<video><source>`) sources: candidates for an unsynced embed. */
  media: string[];
}

/**
 * Injected into the active tab by `chrome.scripting.executeScript({ func })`, so it
 * is serialized with `toString()`: it must stay self-contained (no imports, no
 * outside helpers). Returns raw URLs; the popup decides what is supported.
 */
export function collectCandidateUrls(doc: Document = document): PageScan {
  const urls = [doc.location.href];
  const media: string[] = [];
  for (const el of doc.querySelectorAll("iframe[src], embed[src], object[data], video[src], video source[src]")) {
    const tag = el.localName;
    const raw = el.getAttribute(tag === "object" ? "data" : "src");
    if (raw === null) continue;
    let href: string;
    try {
      href = new URL(raw, doc.baseURI).href;
    } catch {
      continue; // Not a URL; skip it.
    }
    if (tag === "iframe" || tag === "embed" || tag === "object") urls.push(href);
    if (tag === "iframe" || tag === "video" || tag === "source") media.push(href);
    if (urls.length + media.length >= 1000) break;
  }
  return { urls, media };
}
