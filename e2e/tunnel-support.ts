// The tunnel lane (OME-132): one server in tunnel mode behind the local TLS proxy, plus clients that talk to it
// the way the internet would (docs/research/m2-tunnel-safety.md §8.2). Everything is worker-scoped: one build,
// one server, one proxy per run.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:https";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext } from "@playwright/test";
import { test as base, watchCsp } from "./support/csp";
import { PORTS, ROOT } from "./support/apps";
import { stubExternalNetwork } from "./support/network";
import { EVIL_HOST, PUBLIC_HOST, startTunnelProxy, type TunnelProxy } from "./fixtures/proxy";

function portFrom(name: string, fallback: number): number {
  const raw = process.env[name];
  const port = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`${name} must be a port number, got ${String(raw)}`);
  return port;
}

export const TUNNEL_PORTS = {
  /** 4430 by default; QA2's alternate lane (OMEGA_FIXTURE_PORT=4410) lands on 4440. */
  proxy: portFrom("OMEGA_PROXY_PORT", PORTS.fixtures + 30),
  /** Next to the ordinary server, so both lanes can run side by side. */
  server: portFrom("OMEGA_TUNNEL_SERVER_PORT", PORTS.server + 1),
} as const;

export const PUBLIC_ORIGIN = `https://${PUBLIC_HOST}`;
export const EVIL_ORIGIN = `https://${EVIL_HOST}`;
/**
 * Stands in for the ngrok authtoken. It is in the server's environment for the whole run, so any log line or
 * response that echoed env would show it (ADR 0015 §2, T-14).
 */
export const SENTINEL_AUTHTOKEN = `2fakeTestOnly${randomBytes(12).toString("hex")}_OME132sentinelAuthtoken`;

/** Chromium resolves both test hosts to the proxy; the page gets a real https Origin and a secure context. */
export const TUNNEL_BROWSER_ARGS = [
  `--host-resolver-rules=MAP ${PUBLIC_HOST} 127.0.0.1:${String(TUNNEL_PORTS.proxy)}, MAP ${EVIL_HOST} 127.0.0.1:${String(TUNNEL_PORTS.proxy)}`,
];

export interface TunnelLane {
  readonly proxy: TunnelProxy;
  /** Everything the server has printed so far. */
  readonly serverLog: () => string;
  /** The site build the server serves (built without VITE_SERVER_URL, so it uses its own origin). */
  readonly siteDir: string;
}

function buildSite(): string {
  const outDir = mkdtempSync(join(tmpdir(), "omega-tunnel-site-"));
  // The sentinel is in the build's environment too: nothing may bake it into the bundle.
  const env: NodeJS.ProcessEnv = { ...process.env, NGROK_AUTHTOKEN: SENTINEL_AUTHTOKEN };
  delete env["VITE_SERVER_URL"];
  const r = spawnSync("bunx", ["vite", "build", "--outDir", outDir, "--emptyOutDir", "--logLevel", "error"], {
    cwd: join(ROOT, "apps/web"),
    env,
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`site build failed:\n${r.stdout}\n${r.stderr}`);
  return outDir;
}

/**
 * Waits for *our* child's startup line, not just any answer on the port: a stale server from another run or a
 * retry could answer /healthz there without tunnel mode, and the suite would test the wrong thing.
 */
async function waitStarted(port: number, child: ChildProcess, log: () => string): Promise<void> {
  const line = `omega-share server on http://127.0.0.1:${String(port)}/`;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`tunnel server exited ${String(child.exitCode)}:\n${log()}`);
    if (log().includes(line) && log().includes(`public origin ${PUBLIC_ORIGIN}`)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`tunnel server did not start on :${String(port)}:\n${log()}`);
}

function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once("exit", () => {
      resolve();
    });
    child.kill();
  });
}

async function startLane(): Promise<TunnelLane & { stop: () => Promise<void> }> {
  const siteDir = buildSite();
  let output = "";
  const child = spawn("bun", ["apps/server/src/index.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(TUNNEL_PORTS.server),
      HOST: "127.0.0.1",
      PUBLIC_ORIGIN,
      TRUST_PROXY: "loopback",
      STATIC_DIR: siteDir,
      NGROK_AUTHTOKEN: SENTINEL_AUTHTOKEN,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d: Buffer) => (output += d.toString()));
  child.stderr.on("data", (d: Buffer) => (output += d.toString()));
  const log = (): string => output;
  let proxy: TunnelProxy;
  try {
    await waitStarted(TUNNEL_PORTS.server, child, log);
    proxy = await startTunnelProxy({ port: TUNNEL_PORTS.proxy, upstreamPort: TUNNEL_PORTS.server });
  } catch (err) {
    await stopChild(child);
    throw err;
  }
  return {
    proxy,
    serverLog: log,
    siteDir,
    stop: async () => {
      await proxy.close();
      await stopChild(child);
      rmSync(siteDir, { recursive: true, force: true });
    },
  };
}

// ---- Clients that speak to the proxy directly (curl, a script, another server) ----

export interface RawResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: string;
}

export interface RawRequest {
  readonly method?: string;
  readonly path: string;
  /** `Host` header; the tunnel keeps whatever the client sent. Default the public host. */
  readonly host?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  /** Proxy port; default the lane's. */
  readonly port?: number;
}

/** An HTTPS request to the proxy with full control over `Host` and every header. */
export function tunnelRequest({ port = TUNNEL_PORTS.proxy, method = "GET", path, host = PUBLIC_HOST, headers = {}, body }: RawRequest): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        servername: PUBLIC_HOST,
        rejectUnauthorized: false,
        agent: false,
        method,
        path,
        headers: { host, ...headers, ...(body === undefined ? {} : { "content-length": String(Buffer.byteLength(body)) }) },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (text += c));
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text });
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

export interface Upgrade {
  /** 101 when the server accepted the WebSocket, else its refusal status. */
  readonly status: number;
  readonly close: () => void;
}

/** A raw WebSocket upgrade through the proxy. An accepted socket stays open (unjoined) until `close()`. */
export function tunnelUpgrade({ port = TUNNEL_PORTS.proxy, path, host = PUBLIC_HOST, headers = {} }: Omit<RawRequest, "method" | "body">): Promise<Upgrade> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port,
      servername: PUBLIC_HOST,
      rejectUnauthorized: false,
      agent: false,
      path,
      headers: {
        host,
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": randomBytes(16).toString("base64"),
        ...headers,
      },
    });
    req.on("upgrade", (res, socket: Socket) => {
      resolve({ status: res.statusCode ?? 101, close: () => socket.destroy() });
    });
    req.on("response", (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0, close: () => req.destroy() });
    });
    req.on("error", reject);
    req.end();
  });
}

// ---- Fixtures ----

export interface TunnelWorkerFixtures {
  readonly lane: TunnelLane;
  /** Plain Chromium (no extension) resolving omega.test and evil.test to the proxy. */
  readonly tunnelBrowser: Browser;
}

export interface TunnelTestFixtures {
  /** A fresh context on `tunnelBrowser` with external embeds stubbed and the test hosts left to the network. */
  readonly newTunnelContext: () => Promise<BrowserContext>;
}

/** The stub answers every non-localhost host; the tunnel hosts must reach the proxy instead. */
export async function passTunnelHosts(context: BrowserContext): Promise<void> {
  await stubExternalNetwork(context);
  // Registered last, so it runs first (Playwright tries routes newest first).
  await context.route(
    (url) => url.hostname === PUBLIC_HOST || url.hostname === EVIL_HOST,
    (route) => route.continue(),
  );
}

export const test = base.extend<TunnelTestFixtures, TunnelWorkerFixtures>({
  lane: [
    async ({}, use) => {
      const lane = await startLane();
      await use(lane);
      await lane.stop();
    },
    { scope: "worker", timeout: 120_000 },
  ],
  tunnelBrowser: [
    async ({}, use) => {
      const browser = await chromium.launch({ channel: "chromium", args: TUNNEL_BROWSER_ARGS });
      await use(browser);
      await browser.close();
    },
    { scope: "worker" },
  ],
  newTunnelContext: async ({ tunnelBrowser }, use) => {
    const opened: BrowserContext[] = [];
    await use(async () => {
      const context = await watchCsp(await tunnelBrowser.newContext({ ignoreHTTPSErrors: true }));
      await passTunnelHosts(context);
      opened.push(context);
      return context;
    });
    await Promise.all(opened.map((c) => c.close()));
  },
});

export { expect } from "@playwright/test";
