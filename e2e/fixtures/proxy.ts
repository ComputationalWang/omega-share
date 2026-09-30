// Local stand-in for the ngrok tunnel (OME-132, docs/research/m2-tunnel-safety.md §8.2), so CI never needs ngrok.
// TLS in front of the loopback server. Like ngrok it keeps `Host`, passes a client's `X-Forwarded-Host` through,
// appends the client address to `X-Forwarded-For` and sets `X-Forwarded-Proto: https`. HTTP and WebSocket upgrades
// are piped byte for byte, so the server's own status (403/421/429/503) reaches the client unchanged.
//
// Test-only knob: `x-fixture-client: <ip>` is stripped and appended to XFF instead of the socket peer, so one run
// can play many clients. Requests for `evil.test` never reach the server: they get a blank hostile page.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { request, type IncomingMessage, type OutgoingHttpHeaders } from "node:http";
import { createServer } from "node:https";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const PUBLIC_HOST = "omega.test";
export const EVIL_HOST = "evil.test";
export const FIXTURE_CLIENT_HEADER = "x-fixture-client";

/** `forward`: the tunnel is up. `offline`: the agent is gone, the edge answers its HTML 404. `down`: nothing answers. */
export type ProxyMode = "forward" | "offline" | "down";

export interface ProxyOptions {
  readonly port: number;
  readonly upstreamPort: number;
}

export interface TunnelProxy {
  readonly port: number;
  setMode(mode: ProxyMode): void;
  close(): Promise<void>;
}

/** What ngrok's edge answers when its agent is offline (ERR_NGROK_3200): an HTML page, not the API contract. */
const OFFLINE_PAGE = "<!doctype html><title>ngrok offline</title><p>The endpoint omega.test is offline.</p>";
const EVIL_PAGE = "<!doctype html><title>evil.test</title><p>a hostile page</p>";

/**
 * A throwaway self-signed certificate for omega.test and evil.test, made per run so no private key is ever
 * committed. Browsers under test run with `ignoreHTTPSErrors`; clients here skip verification.
 */
export function makeTestCertificate(): { cert: string; key: string } {
  const dir = mkdtempSync(join(tmpdir(), "omega-proxy-tls-"));
  const key = join(dir, "key.pem");
  const cert = join(dir, "cert.pem");
  execFileSync(
    "openssl",
    ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", `/CN=${PUBLIC_HOST}`,
      "-addext", `subjectAltName=DNS:${PUBLIC_HOST},DNS:${EVIL_HOST}`],
    { stdio: "ignore" },
  );
  return { cert: readFileSync(cert, "utf8"), key: readFileSync(key, "utf8") };
}

const hostName = (req: IncomingMessage): string => (req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();

/** The client's headers as they leave the tunnel: raw order and duplicates kept, XFF appended, proto set. */
export function forwardedHeaders(req: IncomingMessage): OutgoingHttpHeaders {
  const out: Record<string, string | string[]> = {};
  const xff: string[] = [];
  let client = req.socket.remoteAddress ?? "unknown";
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i] ?? "";
    const value = req.rawHeaders[i + 1] ?? "";
    const lower = name.toLowerCase();
    if (lower === FIXTURE_CLIENT_HEADER) client = value;
    else if (lower === "x-forwarded-for") xff.push(value);
    else if (lower === "x-forwarded-proto") continue;
    else {
      const prev = out[lower];
      out[lower] = prev === undefined ? value : [...(Array.isArray(prev) ? prev : [prev]), value];
    }
  }
  out["x-forwarded-for"] = [...xff, client].join(", ");
  out["x-forwarded-proto"] = "https";
  return out;
}

function headerBlock(req: IncomingMessage): string {
  const lines = [`${req.method ?? "GET"} ${req.url ?? "/"} HTTP/1.1`];
  for (const [name, value] of Object.entries(forwardedHeaders(req))) {
    for (const v of Array.isArray(value) ? value : [String(value)]) lines.push(`${name}: ${v}`);
  }
  return `${lines.join("\r\n")}\r\n\r\n`;
}

export async function startTunnelProxy({ port, upstreamPort }: ProxyOptions): Promise<TunnelProxy> {
  let mode: ProxyMode = "forward";
  const sockets = new Set<Socket>();
  const server = createServer(makeTestCertificate());

  server.on("connection", (socket: Socket) => {
    if (mode === "down") {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  server.on("request", (req, res) => {
    if (hostName(req) === EVIL_HOST) {
      res.writeHead(200, { "content-type": "text/html" }).end(EVIL_PAGE);
      return;
    }
    if (mode === "offline") {
      res.writeHead(404, { "content-type": "text/html", "ngrok-error-code": "ERR_NGROK_3200" }).end(OFFLINE_PAGE);
      return;
    }
    const upstream = request(
      { host: "127.0.0.1", port: upstreamPort, method: req.method, path: req.url, headers: forwardedHeaders(req) },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.rawHeaders);
        up.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end("bad gateway");
    });
    req.pipe(upstream);
  });

  server.on("upgrade", (req: IncomingMessage, client: Socket, head: Buffer) => {
    if (mode !== "forward" || hostName(req) === EVIL_HOST) {
      client.end("HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\n\r\n");
      return;
    }
    const upstream = connect(upstreamPort, "127.0.0.1", () => {
      upstream.write(headerBlock(req));
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    const drop = (): void => {
      upstream.destroy();
      client.destroy();
    };
    upstream.on("error", drop);
    client.on("error", drop);
    upstream.on("close", drop);
    client.on("close", drop);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    port,
    setMode(next) {
      mode = next;
      if (next !== "forward") for (const s of sockets) s.destroy();
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
