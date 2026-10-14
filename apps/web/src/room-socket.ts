// The room page's sockets (split out of room.ts, OME-1100): the DOM WebSocket as the connection's SocketLike, and a
// connection that never connects.
import type { Connection, SocketLike } from "./connection";

/** Adapts the DOM WebSocket to the connection's SocketLike. */
export function browserSocket(url: string): SocketLike {
  const ws = new WebSocket(url);
  const s: SocketLike = {
    send: (d) => {
      ws.send(d);
    },
    close: (code) => {
      ws.close(code);
    },
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  ws.onopen = () => s.onopen?.();
  ws.onmessage = (ev: MessageEvent<unknown>) => s.onmessage?.({ data: ev.data });
  ws.onclose = (ev) => s.onclose?.({ code: ev.code });
  ws.onerror = () => s.onerror?.();
  return s;
}

/** A connection that never connects: a tab still inside its rejoin cooldown (kick-memory.ts). */
export function stoppedConnection(): Connection {
  return { send: () => false, close: () => undefined, resume: () => undefined, ensureConnected: () => undefined, reclaim: () => undefined };
}
