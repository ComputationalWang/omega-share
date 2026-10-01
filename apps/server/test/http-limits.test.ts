import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { Client, postShare, start, tokenOf, type TestServer } from "./helpers";

/** Threat model §10 "HTTP floods" (OME-274): a per-key request bucket on every HTTP route, and a global in-flight cap. */
let t: TestServer | null = null;
const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await t?.server.stop(true);
  t = null;
});

/** A stopped clock: no bucket refills during a test unless it moves `time` by hand. */
let time = 0;
const now = () => time;

/** A request as the tunnel forwards it: from loopback, the client's address the rightmost XFF entry. */
const getAs = (xff: string, path = "/healthz") => fetch(`${t?.http ?? ""}${path}`, { headers: { "x-forwarded-for": xff } });
async function statuses(xff: string, n: number, path?: string): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const res = await getAs(xff, path);
    await res.arrayBuffer();
    out.push(res.status);
  }
  return out;
}

/** Floods `xff` until it is refused, returning the refusal. */
async function exhaust(xff: string, path?: string): Promise<Response> {
  for (let i = 0; i < 1000; i++) {
    const res = await getAs(xff, path);
    if (res.status === 429) return res;
    await res.arrayBuffer();
  }
  throw new Error("never limited");
}

/** Shaped like `apps/web/dist` (29 files at OME-274): index.html plus hashed JS, CSS, images and source maps. */
const SITE_ASSETS = 40;
function site(): string {
  const dist = join(mkdtempSync(join(tmpdir(), "omega-site-")), "dist");
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>omega</title>");
  for (let i = 0; i < SITE_ASSETS; i++) writeFileSync(join(dist, "assets", `chunk${String(i)}-Ab12Cd34.js`), "0");
  return dist;
}

describe("per-key HTTP request limit", () => {
  test("a burst over the bucket gets 429 with Retry-After, on every route", async () => {
    t = start({ trustProxy: true, now, staticDir: site() });
    for (const [i, path] of ["/healthz", "/rooms", "/", "/assets/chunk0-Ab12Cd34.js", "/rooms/lobby/share"].entries()) {
      const refused = await exhaust(`198.51.100.${String(i + 1)}`, path);
      expect(refused.status).toBe(429);
      expect(Number(refused.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    }
  });

  test("a different key is unaffected, and a refill lets the limited key back in", async () => {
    t = start({ trustProxy: true, now });
    await exhaust("198.51.100.1");
    expect(await statuses("198.51.100.2", 5)).toEqual([200, 200, 200, 200, 200]);
    time += 60_000;
    expect((await getAs("198.51.100.1")).status).toBe(200);
  });

  test("prepending to X-Forwarded-For does not make a new key (T-07)", async () => {
    t = start({ trustProxy: true, now });
    await exhaust("198.51.100.1");
    expect((await getAs("10.9.9.9, 198.51.100.1")).status).toBe(429);
  });

  test("a full cold page load, then a reload, never hits the limit", async () => {
    t = start({ trustProxy: true, now, staticDir: site() });
    const load = () =>
      Promise.all(
        ["/", "/rooms", ...Array.from({ length: SITE_ASSETS }, (_, i) => `/assets/chunk${String(i)}-Ab12Cd34.js`)].map(async (path) => {
          const res = await getAs("198.51.100.1", path);
          await res.arrayBuffer();
          return res.status;
        }),
      );
    for (const status of [...(await load()), ...(await load())]) expect(status).toBe(200);
  });

  test("WebSocket upgrades keep their own limiter and don't use up the HTTP bucket (ADR 0018)", async () => {
    t = start({ trustProxy: true, now });
    // The upgrade limiter allows 10 per key; joining and leaving them must not touch the HTTP bucket.
    for (let i = 0; i < 10; i++) {
      const c = await Client.open(t.ws(), undefined, { "x-forwarded-for": "198.51.100.1" });
      c.close();
    }
    const res = await fetch(`${t.http}/rooms/lobby/ws`, { headers: { upgrade: "websocket", "x-forwarded-for": "198.51.100.1" } });
    expect(res.status).toBe(429);
    expect(await res.text()).toBe("reconnecting too fast");
    expect((await getAs("198.51.100.1")).status).toBe(200);
  });

  test("loopback peers without the proxy skip the per-key limit (ADR 0018 §3: local dev, e2e, the load test)", async () => {
    t = start({ now });
    for (let i = 0; i < 300; i++) {
      const res = await fetch(`${t.http}/healthz`);
      await res.arrayBuffer();
      expect(res.status).toBe(200);
    }
  });

  const lan = Object.values(networkInterfaces())
    .flat()
    .find((a) => a !== undefined && a.family === "IPv4" && !a.internal)?.address;
  test.skipIf(lan === undefined)("spoofed X-Forwarded-For from a non-loopback peer is ignored (T-08)", async () => {
    t = start({ trustProxy: true, now, hostname: "0.0.0.0" });
    const port = String(t.server.port);
    const fromLan = (xff: string) =>
      fetch(`http://${lan ?? ""}:${port}/healthz`, { headers: { host: `localhost:${port}`, "x-forwarded-for": xff } });
    let refused: Response | null = null;
    for (let i = 0; i < 1000 && refused === null; i++) {
      // A fresh spoofed address every time: if it counted, this would never be limited.
      const res = await fromLan(`198.51.100.${String(i % 250)}`);
      if (res.status === 429) refused = res;
      else await res.arrayBuffer();
    }
    expect(refused?.status).toBe(429);
  });
});

describe("global in-flight HTTP cap", () => {
  test("when full, the next request gets 503 with Retry-After; it clears once a request finishes", async () => {
    t = start({ trustProxy: true, now, maxHttpInFlight: 1 });
    const { client, snapshot } = await Client.join(t.ws(), "slow", 0, { "x-forwarded-for": "198.51.100.1" });
    clients.push(client);
    // A share whose body never finishes holds its slot until we end it.
    let finish = (): void => {};
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"url":"https://youtu.be/dQw4w9WgXcQ"'));
        finish = () => {
          controller.enqueue(new TextEncoder().encode("}"));
          controller.close();
        };
      },
    });
    const slow = fetch(`${t.http}/rooms/lobby/share`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tokenOf(snapshot)}`, "x-forwarded-for": "198.51.100.1" },
      body,
    });
    await Bun.sleep(100);
    const full = await getAs("198.51.100.2");
    expect(full.status).toBe(503);
    expect(Number(full.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    finish();
    expect((await slow).status).toBe(200);
    expect((await getAs("198.51.100.2")).status).toBe(200);
  });

  test("the cap holds however many keys the requests come from, loopback included", async () => {
    t = start({ now, maxHttpInFlight: 0 });
    expect((await fetch(`${t.http}/healthz`)).status).toBe(503);
    expect((await postShare(t, "{}")).status).toBe(503);
  });
});
