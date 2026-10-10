/** Stub (OME-767 red commit): the landing's install row. */
export const FIREFOX_LISTING_URL: string | null = "";
export const CHROME_LISTING_URL: string | null = "";

export interface Listings {
  readonly firefox: string | null;
  readonly chrome: string | null;
}

export function installLinks(_listings: Listings): string {
  return "";
}

export function withInstallLinks(html: string, _listings: Listings): string {
  return html;
}
