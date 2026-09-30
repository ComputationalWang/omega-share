/**
 * The meta CSP in index.html pins three dev origins in `connect-src` (server ws, server http, Vite HMR ws).
 * e2e/perf run on other ports, so the Vite plugin rewrites just those three from the configured values.
 * In `vite build` the HMR origin is harmless and is left at the default web port (5173).
 */
export interface DevOriginInput {
  /** `VITE_SERVER_URL`; ignored unless it is a plain http(s) origin. */
  readonly serverUrl?: string | undefined;
  /** The web dev server's port, for the HMR websocket. */
  readonly webPort?: number | undefined;
}

const DEFAULT_SERVER = "localhost:8787";
const DEFAULT_WEB_PORT = 5173;

export function devConnectSrc({ serverUrl, webPort }: DevOriginInput): readonly [string, string, string] {
  let host = DEFAULT_SERVER;
  let secure = false;
  if (serverUrl !== undefined && serverUrl !== "") {
    try {
      const u = new URL(serverUrl);
      if ((u.protocol === "http:" || u.protocol === "https:") && /^[a-z0-9.:[\]-]+$/i.test(u.host)) {
        host = u.host;
        secure = u.protocol === "https:";
      }
    } catch {
      // not a URL: keep the defaults
    }
  }
  const port = webPort !== undefined && Number.isInteger(webPort) && webPort > 0 && webPort < 65536 ? webPort : DEFAULT_WEB_PORT;
  return [`${secure ? "wss" : "ws"}://${host}`, `${secure ? "https" : "http"}://${host}`, `ws://localhost:${String(port)}`];
}

/** Replaces everything after `'self'` in the meta CSP's `connect-src` with `sources`. */
export function withConnectSrc(html: string, sources: readonly string[]): string {
  const re = /connect-src 'self'[^;"]*/;
  if (!re.test(html)) throw new Error("no connect-src in index.html CSP");
  return html.replace(re, () => ["connect-src 'self'", ...sources].join(" "));
}
