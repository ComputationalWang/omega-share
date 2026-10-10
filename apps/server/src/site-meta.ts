import { ROOM_TITLE_MAX_LENGTH } from "@omega/shared";

/**
 * The share card (Open Graph + Twitter) written into every served page, so a pasted link previews
 * without running our JS (research m9-release-legal §5). Only a public, listable room's title is ever
 * personalised; anything else gets the generic card, byte for byte, so a preview leaks nothing.
 */
export const SITE_NAME = "omega-share";
const DESCRIPTION = "Watch videos together in a cosy pixel room. Share a video from any page with the browser extension and sit with friends, in sync.";
/** Our own CC BY-SA card, the same for every room: never a provider thumbnail (§5.2 item 4). */
export const OG_IMAGE_PATH = "/og-image.png";
const OG_TITLE_MAX = 80;
/** Bidi controls, zero-width characters, the BOM and Hangul fillers: invisible, or they reorder the text around them. */
const INVISIBLE = /[\u061C\u115F\u1160\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\u3164\uFEFF\uFFA0]/gu;

const escapeAttr = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Code points, not UTF-16 units, so a cut never splits a surrogate pair. */
const cut = (s: string, max: number): string => Array.from(s).slice(0, max).join("");

function ogTitle(title: string | null): string {
  // Titles are NFKC and bidi-free by schema; a seeded or legacy row may not be, so clean again.
  const clean = cut((title ?? "").normalize("NFKC").replace(INVISIBLE, "").replace(/\s+/gu, " ").trim(), ROOM_TITLE_MAX_LENGTH).trim();
  return clean === "" ? SITE_NAME : cut(`${clean} · ${SITE_NAME}`, OG_TITLE_MAX);
}

/** The `<head>` tags for a page: `title` is a public room's title, or null for the generic card. */
export function siteMeta(origin: string, title: string | null): string {
  const t = escapeAttr(ogTitle(title));
  const d = escapeAttr(DESCRIPTION);
  return [
    `<meta name="description" content="${d}" />`,
    `<meta property="og:site_name" content="${SITE_NAME}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:title" content="${t}" />`,
    `<meta property="og:description" content="${d}" />`,
    `<meta property="og:image" content="${escapeAttr(origin + OG_IMAGE_PATH)}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta property="og:image:alt" content="${SITE_NAME}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<link rel="icon" href="/favicon.ico" sizes="32x32" />`,
    `<link rel="apple-touch-icon" href="/apple-touch-icon.png" />`,
    `<link rel="manifest" href="/manifest.webmanifest" />`,
  ].join("");
}

/** `page` with `meta` added just before `</head>` (or unchanged if it has none). */
export function withMeta(page: string, meta: string): string {
  const at = page.indexOf("</head>");
  return at === -1 ? page : page.slice(0, at) + meta + page.slice(at);
}
