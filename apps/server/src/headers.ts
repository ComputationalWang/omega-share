const SYNCED_FRAMES = "frame-src https://www.youtube-nocookie.com https://player.twitch.tv https://player.vimeo.com";

/**
 * Security headers on every response (threat model §4). This is the production policy: production is
 * always same-origin (ADR 0015 §1). Header and `<meta>` CSPs intersect, so the meta in
 * `apps/web/index.html` must be a superset of `CSP` that only adds the dev origins.
 * `CSP` is the policy with GENERIC_EMBEDS=off; `CSP_WITH_GENERIC` (the default) also frames `https:`.
 */
export const CSP = [
  "default-src 'self'",
  // The three provider SDK loaders, path-scoped; no inline script or eval.
  "script-src 'self' https://www.youtube.com/iframe_api https://www.youtube.com/s/player/ https://player.twitch.tv/js/embed/v1.js https://player.vimeo.com/api/player.js",
  "style-src 'self'",
  "img-src 'self' data:",
  // CSP3 'self' matches the page's own ws:/wss: origin.
  "connect-src 'self'",
  "worker-src 'self'",
  SYNCED_FRAMES,
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * The generic tier frames any https page (ADR 0024 §4). The three synced origins stay listed so the
 * synced tier still works if `https:` goes. `script-src` is the same as in `CSP`.
 */
export const CSP_WITH_GENERIC = CSP.replace(SYNCED_FRAMES, `${SYNCED_FRAMES} https:`);

/** Report-only in M3 (enforce in M4 if the real-provider run is clean). No `report-to`: no public report sink. */
export const CSP_REPORT_ONLY = "require-trusted-types-for 'script'; trusted-types omega-sdk";

/**
 * Powerful features we never use. Autoplay, fullscreen, picture-in-picture and encrypted-media stay
 * off this list: the player iframes get them through `allow`, and a header allowlist would block that.
 */
export const PERMISSIONS_POLICY = [
  "camera",
  "microphone",
  "geolocation",
  "payment",
  "usb",
  "serial",
  "hid",
  "bluetooth",
  "display-capture",
]
  .map((feature) => `${feature}=()`)
  .join(", ");

export type SecurityHeaders = Readonly<Record<string, string>>;

/** No COEP: `require-corp` would block the provider iframes and scripts, which send no CORP. */
const headersWith = (csp: string): SecurityHeaders =>
  Object.freeze({
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "content-security-policy": csp,
    "content-security-policy-report-only": CSP_REPORT_ONLY,
    "permissions-policy": PERMISSIONS_POLICY,
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
  });

const WITH_GENERIC = headersWith(CSP_WITH_GENERIC);
const SYNCED_ONLY = headersWith(CSP);

/** The headers for every response; `frame-src` follows the GENERIC_EMBEDS switch (ADR 0024 §4). */
export const securityHeaders = (genericEmbeds: boolean): SecurityHeaders => (genericEmbeds ? WITH_GENERIC : SYNCED_ONLY);

/** One year, no `includeSubDomains` or `preload` yet (research M4 D1). Sent only to an https `PUBLIC_ORIGIN` host (server.ts). */
export const HSTS = "max-age=31536000";
