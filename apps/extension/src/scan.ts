/**
 * Injected into the active tab by `chrome.scripting.executeScript({ func })`, so it
 * is serialized with `toString()`: it must stay self-contained (no imports, no
 * outside helpers). Returns raw URLs; the popup decides what is supported.
 */
export function collectCandidateUrls(doc: Document = document): string[] {
  const urls = [doc.location.href];
  for (const el of doc.querySelectorAll("iframe[src], embed[src], object[data]")) {
    const raw = el.getAttribute(el.localName === "object" ? "data" : "src");
    if (raw === null) continue;
    try {
      urls.push(new URL(raw, doc.baseURI).href);
    } catch {
      // Not a URL; skip it.
    }
    if (urls.length >= 500) break;
  }
  return urls;
}
