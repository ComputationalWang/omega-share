// Which documents the zero-CSP fixture (support/csp.ts) fails on (OME-218). A third-party frame, such as a provider's
// player enforcing its own policy, is governed by that policy, never ours. Ours: the top page's origin (the tunnel page
// included), every loopback origin (site, server, fixtures) and non-http(s) documents (extension pages, about:srcdoc,
// blob:). Anything unparseable counts as ours, so the scope can only fail closed.

const isLoopback = (host: string): boolean =>
  host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(host);

/** Whether a violation in `documentURI`, on a page whose top document is `topURL`, is ours to fail on. */
export function isOurDocument(documentURI: string, topURL: string): boolean {
  if (!URL.canParse(documentURI)) return true;
  const doc = new URL(documentURI);
  if (doc.protocol !== "https:" && doc.protocol !== "http:") return true;
  if (isLoopback(doc.hostname)) return true;
  return URL.canParse(topURL) && new URL(topURL).origin === doc.origin;
}
