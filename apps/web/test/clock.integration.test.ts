import { afterAll, expect, test } from "bun:test";
import type { Server } from "bun";
import { parseClientMessage } from "@omega/shared";
import { createClockSync } from "../src/clock";
import { createConnection, type SocketLike } from "../src/connection";

/** The stub server's clock runs this far ahead of the client's. */
const SKEW_MS = 5000;

// Stands in for the M1b server (OME-86): answers `ping` before `join` with `pong{id, at}`.
const server: Server<undefined> = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req, srv) {
    return srv.upgrade(req) ? undefined : new Response("no", { status: 400 });
  },
  websocket: {
    message(ws, data) {
      const msg = typeof data === "string" ? parseClientMessage(data) : null;
      if (msg?.type === "ping") ws.send(JSON.stringify({ type: "pong", id: msg.id, at: Date.now() + SKEW_MS }));
    },
  },
});

afterAll(() => server.stop(true));

function realSocket(url: string): SocketLike {
  const ws = new WebSocket(url);
  const s: SocketLike = {
    send: (d) => ws.send(d),
    close: (code) => ws.close(code),
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  ws.onopen = () => s.onopen?.();
  ws.onmessage = (ev) => s.onmessage?.({ data: ev.data });
  ws.onclose = () => s.onclose?.();
  return s;
}

test("offset error ≤ 25 ms against a real socket on localhost", async () => {
  const now = (): number => performance.timeOrigin + performance.now();
  let clock: ReturnType<typeof createClockSync> | null = null;
  const conn = createConnection({
    url: `ws://127.0.0.1:${server.port}/`,
    join: { type: "join", nickname: "zoe", avatar: 1 },
    createSocket: realSocket,
    onOpen: () => clock?.start(),
    onEvent: (e) => {
      if (e.type === "message" && e.msg.type === "pong") clock?.onPong(e.msg.id, e.msg.at);
    },
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h),
  });
  clock = createClockSync({
    now,
    sendPing: (id) => conn.send({ type: "ping", id }),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h),
  });

  const deadline = Date.now() + 3000;
  while (!clock.ready && Date.now() < deadline) await Bun.sleep(5);
  // Let the whole burst land so the window holds 5 samples.
  await Bun.sleep(1000);
  expect(clock.ready).toBe(true);
  const errorMs = Math.abs(clock.serverNow() - (Date.now() + SKEW_MS));
  expect(errorMs).toBeLessThanOrEqual(25);
  clock.destroy();
  conn.close();
});
