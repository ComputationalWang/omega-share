// Self-checks for the tunnel proxy fixture (e2e/fixtures/proxy.ts) against an echo upstream: it must behave like
// ngrok where the server's safety depends on it, or the tunnel specs prove nothing (OME-132).
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Socket } from "node:net";
import { chromium } from "@playwright/test";
import { watchCsp } from "./support/csp";
import { EVIL_HOST, PUBLIC_HOST, startTunnelProxy, type TunnelProxy } from "./fixtures/proxy";
import { TUNNEL_PORTS, expect, passTunnelHosts, test, tunnelRequest, tunnelUpgrade } from "./tunnel-support";

const PROXY_PORT = TUNNEL_PORTS.proxy + 1;
const UPSTREAM_PORT = TUNNEL_PORTS.server + 100;

interface Seen {
  readonly url: string;
  readonly rawHeaders: readonly string[];
}

/** Echoes each request's raw headers as JSON. Upgrades: `/ws-refuse` → 403, anything else → 101 then echo bytes. */
function echoUpstream(): Promise<{ server: Server; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url ?? "", rawHeaders: req.rawHeaders });
    res.writeHead(207, { "content-type": "application/json", "x-upstream": "yes" }).end(JSON.stringify(req.rawHeaders));
  });
  server.on("upgrade", (req: IncomingMessage, socket: Socket) => {
    seen.push({ url: req.url ?? "", rawHeaders: req.rawHeaders });
    if (req.url === "/ws-refuse") {
      socket.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n");
      return;
    }
    socket.write("HTTP/1.1 101 Switching Protocols\r\nconnection: Upgrade\r\nupgrade: websocket\r\n\r\n");
    socket.pipe(socket);
  });
  return new Promise((resolve) => server.listen(UPSTREAM_PORT, "127.0.0.1", () => {
    resolve({ server, seen });
  }));
}

const header = (raw: readonly string[], name: string): string[] =>
  raw.flatMap((v, i) => (i % 2 === 0 && v.toLowerCase() === name ? [raw[i + 1] ?? ""] : []));

test.describe("tunnel proxy fixture", () => {
  let upstream: { server: Server; seen: Seen[] };
  let proxy: TunnelProxy;

  test.beforeAll(async () => {
    upstream = await echoUpstream();
    proxy = await startTunnelProxy({ port: PROXY_PORT, upstreamPort: UPSTREAM_PORT });
  });
  test.afterAll(async () => {
    await proxy.close();
    await new Promise((resolve) => upstream.server.close(resolve));
  });
  test.beforeEach(() => {
    proxy.setMode("forward");
    upstream.seen.length = 0;
  });

  test("keeps Host, appends the client to X-Forwarded-For, sets proto https, passes X-Forwarded-Host through", async () => {
    const r = await tunnelRequest({
      port: PROXY_PORT,
      path: "/probe?x=1",
      headers: {
        "x-forwarded-for": "6.6.6.6",
        "x-forwarded-proto": "http",
        "x-forwarded-host": "spoofed.example",
        "x-fixture-client": "203.0.113.7",
      },
    });
    expect(r.status).toBe(207);
    expect(r.headers["x-upstream"]).toBe("yes");
    const [got] = upstream.seen;
    expect(got?.url).toBe("/probe?x=1");
    const raw = got?.rawHeaders ?? [];
    expect(header(raw, "host")).toEqual([PUBLIC_HOST]);
    expect(header(raw, "x-forwarded-for")).toEqual(["6.6.6.6, 203.0.113.7"]);
    expect(header(raw, "x-forwarded-proto")).toEqual(["https"]);
    expect(header(raw, "x-forwarded-host")).toEqual(["spoofed.example"]);
    expect(header(raw, "x-fixture-client")).toEqual([]);
  });

  test("without the fixture header the socket peer is appended", async () => {
    await tunnelRequest({ port: PROXY_PORT, path: "/" });
    expect(header(upstream.seen[0]?.rawHeaders ?? [], "x-forwarded-for")).toEqual(["127.0.0.1"]);
  });

  test("relays a WebSocket upgrade both ways, and the upstream's refusal status unchanged", async () => {
    const refused = await tunnelUpgrade({ port: PROXY_PORT, path: "/ws-refuse", headers: { "x-fixture-client": "198.51.100.1" } });
    expect(refused.status).toBe(403);
    refused.close();
    expect(header(upstream.seen[0]?.rawHeaders ?? [], "x-forwarded-for")).toEqual(["198.51.100.1"]);
    expect(header(upstream.seen[0]?.rawHeaders ?? [], "host")).toEqual([PUBLIC_HOST]);

    const accepted = await tunnelUpgrade({ port: PROXY_PORT, path: "/ws" });
    expect(accepted.status).toBe(101);
    accepted.close();
  });

  test("evil.test is served by the proxy and never reaches the upstream", async () => {
    const r = await tunnelRequest({ port: PROXY_PORT, path: "/", host: EVIL_HOST });
    expect(r.status).toBe(200);
    expect(r.body).toContain("evil.test");
    expect(upstream.seen).toHaveLength(0);
  });

  test("offline answers ngrok's HTML 404; down refuses the connection", async () => {
    proxy.setMode("offline");
    const r = await tunnelRequest({ port: PROXY_PORT, path: "/rooms" });
    expect(r.status).toBe(404);
    expect(r.headers["content-type"]).toBe("text/html");
    expect(r.headers["ngrok-error-code"]).toBe("ERR_NGROK_3200");
    proxy.setMode("down");
    await expect(tunnelRequest({ port: PROXY_PORT, path: "/rooms" })).rejects.toThrow();
    expect(upstream.seen).toHaveLength(0);
  });

  test("Chromium reaches it as https://omega.test: secure context, Host kept", async () => {
    const browser = await chromium.launch({
      channel: "chromium",
      args: [`--host-resolver-rules=MAP ${PUBLIC_HOST} 127.0.0.1:${String(PROXY_PORT)}`],
    });
    try {
      const context = await watchCsp(await browser.newContext({ ignoreHTTPSErrors: true }));
      await passTunnelHosts(context);
      const page = await context.newPage();
      const res = await page.goto(`https://${PUBLIC_HOST}/page`);
      expect(res?.status()).toBe(207);
      expect(await page.evaluate(() => [window.isSecureContext, location.origin])).toEqual([true, `https://${PUBLIC_HOST}`]);
      expect(header(upstream.seen[0]?.rawHeaders ?? [], "host")).toEqual([PUBLIC_HOST]);
    } finally {
      await browser.close();
    }
  });
});
