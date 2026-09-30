/**
 * Security headers on every response (threat model §4). This is the production policy: production is
 * always same-origin (ADR 0015 §1). Header and `<meta>` CSPs intersect, so the meta in
 * `apps/web/index.html` must be a superset of `CSP` that only adds the dev origins.
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
  "frame-src https://www.youtube-nocookie.com https://player.twitch.tv https://player.vimeo.com",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

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

/** No COEP: `require-corp` would block the provider iframes and scripts, which send no CORP. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "content-security-policy": CSP,
  "content-security-policy-report-only": CSP_REPORT_ONLY,
  "permissions-policy": PERMISSIONS_POLICY,
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
};
