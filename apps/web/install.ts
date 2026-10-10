/**
 * The landing's install row (OME-767). One constant per store: null until the listing is public, and the row says
 * "coming soon". AMO 0.1.x is still awaiting review (OME-777); the Chrome Web Store waits on the board (OME-591).
 * Plain text links, never a store badge or a remote image. A URL off the store's own https origin fails the build.
 */
export const FIREFOX_LISTING_URL: string | null = null;
export const CHROME_LISTING_URL: string | null = null;

export interface Listings {
  readonly firefox: string | null;
  readonly chrome: string | null;
}

const SLOT = "<!--omega:install-->";
const STORES = [
  { key: "firefox", name: "Firefox", origin: "https://addons.mozilla.org" },
  { key: "chrome", name: "Chrome", origin: "https://chromewebstore.google.com" },
] as const;

const escapeAttr = (s: string): string => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function storeUrl(url: string, origin: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`install link is not a URL: ${url}`);
  }
  if (u.origin !== origin || u.username !== "" || u.password !== "") throw new Error(`install link must be on ${origin}: ${url}`);
  return u.href;
}

export function installLinks(listings: Listings): string {
  return STORES.map(({ key, name, origin }) => {
    const url = listings[key];
    return url === null
      ? `<span class="install-soon">${name}: coming soon</span>`
      : `<a class="enter install-link" href="${escapeAttr(storeUrl(url, origin))}" target="_blank" rel="noopener noreferrer">Add to ${name}</a>`;
  }).join(" · ");
}

export function withInstallLinks(html: string, listings: Listings): string {
  return html.includes(SLOT) ? html.replaceAll(SLOT, () => installLinks(listings)) : html;
}
