import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import { ShareResponseSchema, type RoomId } from "@omega/shared";
import { startServer } from "../src/server";
import { Client, EXTENSION_ORIGIN, SITE_ORIGIN, postShare, start, tokenOf, type TestServer } from "./helpers";

const PUBLIC_ORIGIN = "https://quiet-otter.ngrok-free.app";
const PUBLIC_HOST = "quiet-otter.ngrok-free.app";

let t: TestServer | null = null;
const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await t?.server.stop(true);
  t = null;
});

const port = (): string => String(t?.server.port);
const get = (path: string, headers: Record<string, string> = {}) => fetch(`${t?.http ?? ""}${path}`, { headers });
const upgrade = (headers: Record<string, string>) => get("/rooms/lobby/ws", { upgrade: "websocket", ...headers });

/** A built site: index.html, a hashed asset, and a file outside the root that must never be served. */
function site(): string {
  const parent = mkdtempSync(join(tmpdir(), "omega-site-"));
  writeFileSync(join(parent, "secret.txt"), "outside the root");
  const dist = join(parent, "dist");
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>omega</title>");
  writeFileSync(join(dist, "assets", "main-Ab12Cd34.js"), "console.log(1)");
  return dist;
}

/** The production policy, pinned as literals (threat model §4). The web meta must be a superset of this. */
const CSP =
  "default-src 'self'; " +
  "script-src 'self' https://www.youtube.com/iframe_api https://www.youtube.com/s/player/ https://player.twitch.tv/js/embed/v1.js https://player.vimeo.com/api/player.js; " +
  "style-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; " +
  // `https:` for the generic tier while GENERIC_EMBEDS is on, the default (ADR 0024 §4).
  "frame-src https://www.youtube-nocookie.com https://player.twitch.tv https://player.vimeo.com https:; " +
  "object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const CSP_REPORT_ONLY = "require-trusted-types-for 'script'; trusted-types omega-sdk";
const PERMISSIONS_POLICY =
  "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), bluetooth=(), display-capture=()";

function expectSecurityHeaders(res: Response): void {
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
  expect(res.headers.get("content-security-policy")).toBe(CSP);
  expect(res.headers.get("content-security-policy-report-only")).toBe(CSP_REPORT_ONLY);
  expect(res.headers.get("permissions-policy")).toBe(PERMISSIONS_POLICY);
  expect(res.headers.get("cross-origin-opener-policy")).toBe("same-origin");
  expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  expect(res.headers.get("cross-origin-embedder-policy")).toBeNull();
}

describe("bind (T-11)", () => {
  test("listens on 127.0.0.1 unless told otherwise", async () => {
    const server = startServer({ port: 0, siteOrigin: SITE_ORIGIN });
    try {
      expect(server.hostname).toBe("127.0.0.1");
    } finally {
      await server.stop(true);
    }
  });
});

describe("Host allowlist (T-06, DNS rebinding)", () => {
  test("an unknown Host is refused with 421 on every route, before routing", async () => {
    t = start({ publicOrigin: PUBLIC_ORIGIN });
    for (const host of ["evil.example", `evil.example:${port()}`, `${PUBLIC_HOST}.evil.example`, `127.0.0.2:${port()}`]) {
      for (const path of ["/", "/healthz", "/rooms", "/nope"]) {
        const res = await get(path, { host });
        expect(res.status).toBe(421);
        expectSecurityHeaders(res);
      }
      const share = await fetch(`${t.http}/rooms/lobby/share`, { method: "POST", headers: { host }, body: "{}" });
      expect(share.status).toBe(421);
    }
  });

  test("a WebSocket upgrade with an unknown Host is refused with 421", async () => {
    t = start({ publicOrigin: PUBLIC_ORIGIN });
    expect((await upgrade({ host: "evil.example" })).status).toBe(421);
    expect((await upgrade({ host: `evil.example:${port()}`, origin: PUBLIC_ORIGIN })).status).toBe(421);
  });

  test("the public host and loopback names on our port are accepted, in any case", async () => {
    t = start({ publicOrigin: PUBLIC_ORIGIN });
    for (const host of [PUBLIC_HOST, "Quiet-Otter.NGROK-free.app", `localhost:${port()}`, `127.0.0.1:${port()}`, `[::1]:${port()}`, `LOCALHOST:${port()}`]) {
      expect((await get("/rooms", { host })).status).toBe(200);
    }
  });

  test("without a public origin only loopback names are accepted (localhost dev unchanged)", async () => {
    t = start();
    expect((await get("/rooms", { host: `localhost:${port()}` })).status).toBe(200);
    expect((await get("/rooms", { host: PUBLIC_HOST })).status).toBe(421);
    expect((await get("/rooms", { host: "localhost:1" })).status).toBe(421);
  });
});

describe("HSTS (threat model §10, research M4 D1)", () => {
  const HSTS = "max-age=31536000";
  const hsts = (res: Response): string | null => res.headers.get("strict-transport-security");

  test("an https public origin gets HSTS on every response to the public host, refusals included", async () => {
    t = start({ publicOrigin: PUBLIC_ORIGIN });
    for (const path of ["/healthz", "/rooms", "/nope"]) expect(hsts(await get(path, { host: PUBLIC_HOST }))).toBe(HSTS);
    expect(hsts(await get("/rooms", { host: PUBLIC_HOST, origin: "https://evil.test" }))).toBe(HSTS);
    const refused = await get("/rooms/nowhere/ws", { host: PUBLIC_HOST, upgrade: "websocket" });
    expect(refused.status).toBe(404);
    expect(hsts(refused)).toBe(HSTS);
  });

  test("the same server never sends HSTS to its loopback names (plain http, localhost dev)", async () => {
    t = start({ publicOrigin: PUBLIC_ORIGIN });
    for (const host of [`localhost:${port()}`, `127.0.0.1:${port()}`, `[::1]:${port()}`]) {
      const res = await get("/rooms", { host });
      expect(res.status).toBe(200);
      expect(hsts(res)).toBeNull();
    }
  });

  test("no HSTS without a public origin, or with a plain-http one", async () => {
    t = start();
    expect(hsts(await get("/rooms"))).toBeNull();
    await t.server.stop(true);
    t = start({ publicOrigin: "http://quiet-otter.ngrok-free.app" });
    const res = await get("/rooms", { host: PUBLIC_HOST });
    expect(res.status).toBe(200);
    expect(hsts(res)).toBeNull();
  });
});

describe("Origin allowlist (T-04, T-05)", () => {
  test("the public origin may call the API and connect", async () => {
    t = start({ publicOrigin: PUBLIC_ORIGIN });
    const res = await get("/rooms", { origin: PUBLIC_ORIGIN });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(PUBLIC_ORIGIN);
    const c = await Client.open(t.ws(), PUBLIC_ORIGIN);
    clients.push(c);
    c.send({ type: "join", nickname: "tunnel", avatar: 0 });
    expect((await c.next("snapshot")).room.members).toHaveLength(1);
  });

  test("any other Origin is refused with 403, on plain GETs and upgrades alike", async () => {
    t = start({ publicOrigin: PUBLIC_ORIGIN });
    for (const origin of ["https://evil.test", "http://quiet-otter.ngrok-free.app", `${PUBLIC_ORIGIN}.evil.test`, "null"]) {
      const res = await get("/rooms", { origin });
      expect(res.status).toBe(403);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
      expectSecurityHeaders(res);
      expect((await upgrade({ origin })).status).toBe(403);
    }
  });

  test("the site and extension origins stay allowed, and the dev site is unchanged", async () => {
    t = start();
    for (const origin of [SITE_ORIGIN, EXTENSION_ORIGIN]) {
      const res = await get("/rooms", { origin });
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe(origin);
    }
    expect((await get("/rooms", { origin: PUBLIC_ORIGIN })).status).toBe(403);
  });

  test("EXTENSION_IDS narrows extension origins to the listed ids", async () => {
    t = start({ extensionIds: ["ponmlkjihgfedcbaponmlkjihgfedcba"] });
    expect((await get("/rooms", { origin: "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba" })).status).toBe(200);
    expect((await get("/rooms", { origin: EXTENSION_ORIGIN })).status).toBe(403);
  });

  test("CORS preflight allows the share token and ngrok headers", async () => {
    t = start({ publicOrigin: PUBLIC_ORIGIN });
    const res = await fetch(`${t.http}/rooms/lobby/share`, {
      method: "OPTIONS",
      headers: {
        origin: EXTENSION_ORIGIN,
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type,ngrok-skip-browser-warning",
      },
    });
    const allowed = (res.headers.get("access-control-allow-headers") ?? "").toLowerCase();
    for (const h of ["authorization", "content-type", "ngrok-skip-browser-warning"]) expect(allowed).toContain(h);
  });
});

describe("responses", () => {
  test("carry the strict CSP, TT report-only, Permissions-Policy, COOP and CORP (T-13, W-CSP)", async () => {
    t = start();
    for (const path of ["/", "/healthz", "/rooms", "/nope"]) expectSecurityHeaders(await get(path));
  });

  test("the Permissions-Policy leaves the player features to the iframes' allow attribute", async () => {
    t = start();
    const policy = (await get("/rooms")).headers.get("permissions-policy") ?? "";
    for (const feature of ["autoplay", "fullscreen", "picture-in-picture", "encrypted-media"]) expect(policy).not.toContain(feature);
  });

  test("GET /healthz is the readiness probe; GET / still answers without a static site", async () => {
    t = start();
    const health = await get("/healthz");
    expect(health.status).toBe(200);
    expect(await health.text()).toBe("ok");
    expect((await get("/")).status).toBe(200);
  });
});

describe("serving the built site on the same origin (STATIC_DIR)", () => {
  test("/ and site routes get index.html, not cached", async () => {
    t = start({ staticDir: site(), publicOrigin: PUBLIC_ORIGIN });
    for (const path of ["/", "/r/lobby", "/r/some-room"]) {
      const res = await get(path, { host: PUBLIC_HOST });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") ?? "").toContain("text/html");
      expect(res.headers.get("cache-control")).toBe("no-cache");
      expect(await res.text()).toContain("<title>omega</title>");
      expectSecurityHeaders(res);
    }
  });

  test("hashed assets are immutable; a missing asset is 404, not index.html", async () => {
    t = start({ staticDir: site() });
    const res = await get("/assets/main-Ab12Cd34.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("javascript");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await res.text()).toBe("console.log(1)");
    expectSecurityHeaders(res);
    const missing = await get("/assets/missing-00000000.js");
    expect(missing.status).toBe(404);
    expectSecurityHeaders(missing);
    expect((await get("/favicon.png")).status).toBe(404);
  });

  test("never serves a file outside the root", async () => {
    t = start({ staticDir: site() });
    for (const path of ["/%2e%2e/secret.txt", "/assets/%2e%2e/%2e%2e/secret.txt", "/..%2fsecret.txt", "//secret.txt"]) {
      const res = await get(path);
      expect(await res.text()).not.toContain("outside the root");
    }
  });

  test("a NUL byte in the path is a plain 404, not a 500 with a stack trace", async () => {
    t = start({ staticDir: site() });
    for (const path of ["/foo%00.txt", "/assets/x%00.js", "/r/%00"]) {
      const res = await get(path);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain("at ");
    }
  });

  test("the API and the WebSocket keep their routes, and the served page's origin may use them", async () => {
    t = start({ staticDir: site() });
    const self = `http://127.0.0.1:${port()}`;
    const rooms = await get("/rooms", { origin: self });
    expect(rooms.status).toBe(200);
    expect(rooms.headers.get("content-type") ?? "").toContain("application/json");
    const c = await Client.open(t.ws(), `http://localhost:${port()}`);
    clients.push(c);
    c.send({ type: "join", nickname: "same-origin", avatar: 0 });
    expect((await c.next("snapshot")).room.members).toHaveLength(1);
  });
});

describe("room share limiter (§6 share spam)", () => {
  const URL_BODY = JSON.stringify({ url: "https://youtu.be/dQw4w9WgXcQ" });
  /** Members on distinct forwarded addresses, so only the room limiter can trip. */
  async function members(server: TestServer, roomId: RoomId, n: number): Promise<string[]> {
    return Promise.all(
      Array.from({ length: n }, async (_, i) => {
        const r = await Client.join(server.ws(roomId), `${roomId}-${String(i)}`, 0);
        clients.push(r.client);
        return tokenOf(r.snapshot);
      }),
    );
  }
  const shareAs = (server: TestServer, token: string, i: number, roomId: RoomId = "lobby", body = URL_BODY) =>
    postShare(server, body, { roomId, token, headers: { "x-forwarded-for": `198.51.100.${String(i)}` } });

  test("a room takes a burst of 2 switches, then answers 429 with Retry-After and retryAfterMs", async () => {
    t = start({ trustProxy: true });
    const tokens = await members(t, "lobby", 3);
    const statuses: number[] = [];
    for (const [i, token] of tokens.entries()) {
      const res = await shareAs(t, token, i);
      statuses.push(res.status);
      if (res.status !== 429) continue;
      expectSecurityHeaders(res);
      const retryAfter = Number(res.headers.get("retry-after"));
      expect(Number.isInteger(retryAfter)).toBe(true);
      expect(retryAfter).toBeGreaterThanOrEqual(1);
      expect(retryAfter).toBeLessThanOrEqual(10);
      const body = v.parse(ShareResponseSchema, await res.json());
      if (body.ok) throw new Error("expected a refusal");
      expect(body.error.code).toBe("rate_limited");
      expect(body.error.retryAfterMs).toBeGreaterThan(0);
      expect(body.error.retryAfterMs).toBeLessThanOrEqual(retryAfter * 1000);
    }
    expect(statuses).toEqual([200, 200, 429]);
  });

  test("another room is unaffected", async () => {
    t = start({ trustProxy: true, rooms: ["lobby", "den"] });
    const lobby = await members(t, "lobby", 3);
    for (const [i, token] of lobby.entries()) await shareAs(t, token, i);
    const [den = ""] = await members(t, "den", 1);
    expect((await shareAs(t, den, 50, "den")).status).toBe(200);
  });

  test("a refused URL doesn't use up the room's switches", async () => {
    t = start({ trustProxy: true });
    const tokens = await members(t, "lobby", 4);
    const bad = JSON.stringify({ url: "https://evil.example/video" });
    expect((await shareAs(t, tokens[0] ?? "", 0, "lobby", bad)).status).toBe(400);
    expect((await shareAs(t, tokens[1] ?? "", 1, "lobby", bad)).status).toBe(400);
    expect((await shareAs(t, tokens[2] ?? "", 2)).status).toBe(200);
    expect((await shareAs(t, tokens[3] ?? "", 3)).status).toBe(200);
  });

  test("every share 429 carries Retry-After, including the failed-attempt limiter", async () => {
    t = start();
    let res: Response | null = null;
    for (let i = 0; i < 40 && res?.status !== 429; i++) res = await postShare(t, URL_BODY, { token: "B".repeat(22) });
    expect(res?.status).toBe(429);
    expect(Number(res?.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    const body = v.parse(ShareResponseSchema, await res?.json());
    expect(body.ok ? null : body.error.retryAfterMs).toBeGreaterThan(0);
  });
});
