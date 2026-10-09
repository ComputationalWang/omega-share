import { afterEach, describe, expect, test } from "bun:test";
import { Client, start, type TestServer } from "./helpers";

let t: TestServer | null = null;
const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await t?.server.stop(true);
  t = null;
});

/** A socket as the tunnel would forward it: from loopback, with the client's address appended to XFF. */
async function openAs(xff: string): Promise<Client> {
  const c = await Client.open(t?.ws() ?? "", undefined, { "x-forwarded-for": xff });
  clients.push(c);
  return c;
}
const upgradeAs = (xff: string) =>
  fetch(`${t?.http ?? ""}/rooms/lobby/ws`, { headers: { upgrade: "websocket", "x-forwarded-for": xff } });

describe("socket limits behind the tunnel (T-09)", () => {
  test("each forwarded client gets at most 10 sockets; others are unaffected", async () => {
    t = start({ trustProxy: true });
    for (let i = 0; i < 10; i++) await openAs("198.51.100.1");
    expect((await upgradeAs("198.51.100.1")).status).toBe(429);
    await openAs("198.51.100.2");
  });

  test("prepending to X-Forwarded-For does not make a new client (T-07)", async () => {
    t = start({ trustProxy: true });
    for (let i = 0; i < 10; i++) await openAs(`10.0.0.${String(i)}, 198.51.100.1`);
    expect((await upgradeAs("10.9.9.9, 198.51.100.1")).status).toBe(429);
  });

  test("without TRUST_PROXY, varying X-Forwarded-For does not dodge the per-address cap (T-08)", async () => {
    t = start({ maxConnectionsPerIp: 3 });
    for (let i = 0; i < 3; i++) await openAs(`198.51.100.${String(i)}`);
    expect((await upgradeAs("198.51.100.200")).status).toBe(429);
  });

  test("locally the per-address cap stays 50 (the load test opens 25 members from one address)", async () => {
    t = start();
    for (let i = 0; i < 11; i++) await openAs("198.51.100.1");
  });

  test("by default the global ceiling holds the M6 hosted target: 20 rooms × 25 people = 500 sockets (OME-573)", async () => {
    t = start({ trustProxy: true });
    for (let i = 0; i < 500; i++) await openAs(`198.51.${String(100 + (i >> 8))}.${String(i & 255)}`);
    expect((await upgradeAs("203.0.113.1")).status).not.toBe(503);
  }, 30_000);

  test("a global ceiling holds however many addresses the sockets come from", async () => {
    t = start({ trustProxy: true, maxConnections: 5 });
    for (let i = 0; i < 5; i++) await openAs(`198.51.100.${String(i)}`);
    const res = await upgradeAs("198.51.100.99");
    expect(res.status).toBe(503);
    clients.pop()?.close();
    await Bun.sleep(50);
    await openAs("198.51.100.99");
  });
});
