import { afterEach, describe, expect, test } from "bun:test";
import * as v from "valibot";
import { ShareResponseSchema } from "@omega/shared";
import { measureRelayLatency } from "../src/relay-latency";
import { Client, start, type TestServer } from "./helpers";

let t: TestServer | undefined;
const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await t?.server.stop(true);
});

async function open(url: string) {
  const c = await Client.open(url);
  clients.push(c);
  return c;
}

describe("abuse limits", () => {
  test("a socket that never joins is closed after the join timeout", async () => {
    t = start({ joinTimeoutMs: 100 });
    const idle = await open(t.ws());
    const joined = await open(t.ws());
    joined.send({ type: "join", nickname: "alice", avatar: 0 });
    await joined.next("snapshot");
    const ev = await idle.closed;
    expect(ev.code).toBe(1008);
    await Bun.sleep(100);
    expect(joined.socket.readyState).toBe(WebSocket.OPEN);
  });

  test("a message flood is cut off with rate_limited and not relayed past the burst", async () => {
    t = start();
    const a = await Client.join(t.ws(), "alice");
    const b = await Client.join(t.ws(), "bob");
    clients.push(a.client, b.client);
    for (let i = 0; i < 100; i++) a.client.send({ type: "chat", text: `spam ${String(i)}` });
    expect((await a.client.next("error")).code).toBe("rate_limited");
    await Bun.sleep(100);
    let relayed = 0;
    for (;;) {
      try {
        await b.client.next("chat", 20);
        relayed++;
      } catch {
        break;
      }
    }
    expect(relayed).toBeGreaterThan(0);
    expect(relayed).toBeLessThan(40);
  });

  test("too many sockets from one address are refused with 429", async () => {
    t = start({ maxConnectionsPerIp: 3 });
    for (let i = 0; i < 3; i++) await open(t.ws());
    const res = await fetch(`${t.http}/rooms/lobby/ws`, { headers: { upgrade: "websocket" } });
    expect(res.status).toBe(429);
    clients.pop()?.close();
    await Bun.sleep(50);
    await open(t.ws());
  });

  test("share is rate limited per address with 429 rate_limited", async () => {
    t = start();
    const http = t.http;
    const statuses: number[] = [];
    for (let i = 0; i < 20; i++) {
      const res = await fetch(`${http}/rooms/lobby/share`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://youtu.be/dQw4w9WgXcQ" }),
      });
      statuses.push(res.status);
      if (res.status === 429) {
        const body = v.parse(ShareResponseSchema, await res.json());
        expect(body.ok ? null : body.error.code).toBe("rate_limited");
      }
    }
    expect(statuses[0]).toBe(200);
    expect(statuses.at(-1)).toBe(429);
  });

  test("a chunked share body over 4 KB of UTF-8 is refused, even under 4096 characters", async () => {
    t = start();
    const body = Buffer.from(JSON.stringify({ url: "https://youtu.be/" + "é".repeat(2100) }));
    expect(body.toString().length).toBeLessThan(4096);
    expect(body.length).toBeGreaterThan(4096);
    // Raw HTTP so there is no content-length: fetch() would add one.
    const head = `POST /rooms/lobby/share HTTP/1.1\r\nhost: x\r\ncontent-type: application/json\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n`;
    const raw = Buffer.concat([Buffer.from(head + body.length.toString(16) + "\r\n"), body, Buffer.from("\r\n0\r\n\r\n")]);
    const port = t.server.port ?? 0;
    const response = await new Promise<string>((resolve) => {
      let got = "";
      void Bun.connect({
        hostname: "127.0.0.1",
        port,
        socket: {
          open(sock) {
            sock.write(raw);
          },
          data(_sock, chunk) {
            got += chunk.toString();
          },
          close() {
            resolve(got);
          },
        },
      });
    });
    expect(response.split("\r\n")[0]).toBe("HTTP/1.1 413 Payload Too Large");
    expect(response).toContain("payload_too_large");
  });

  test("the latency probe refuses a run with no samples", async () => {
    t = start();
    let error: unknown = null;
    try {
      await measureRelayLatency({ url: t.ws(), clients: 2, samples: 0 });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(Error);
  });
});
