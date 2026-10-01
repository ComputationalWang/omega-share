/**
 * AGPL-3.0 §13: a public network service must offer its users the source. The site footer links here.
 * One place for the URL: index.html carries a placeholder that the Vite plugin fills at dev and build time.
 * A fork sets `VITE_SOURCE_URL` to its own repository; anything but a plain https URL falls back to ours.
 */
export const REPO_URL = "https://github.com/ComputationalWang/omega-share";

const PLACEHOLDER = "%OMEGA_SOURCE_URL%";

export function sourceUrl(configured: string | undefined): string {
  if (configured === undefined || configured === "") return REPO_URL;
  try {
    const u = new URL(configured);
    if (u.protocol !== "https:" || u.username !== "" || u.password !== "") return REPO_URL;
    return u.href.replace(/\/$/, "");
  } catch {
    return REPO_URL;
  }
}

const escapeAttr = (s: string): string => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function withSourceLink(html: string, url: string): string {
  if (!html.includes(PLACEHOLDER)) throw new Error(`no ${PLACEHOLDER} in index.html`);
  return html.replaceAll(PLACEHOLDER, () => escapeAttr(url));
}
