import { parseServerMessage, type ClientMessage, type ServerMessage } from "@omega/shared";

/** The part of `WebSocket` we use, so tests can fake it. */
export interface SocketLike {
  send(data: string): void;
  close(code?: number): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

export type ConnectionEvent =
  | { readonly type: "connecting" }
  | { readonly type: "disconnected" }
  | { readonly type: "message"; readonly msg: ServerMessage };

export interface ConnectionOptions<Timer = unknown> {
  readonly url: string;
  readonly join: Extract<ClientMessage, { type: "join" }>;
  readonly createSocket: (url: string) => SocketLike;
  readonly onEvent: (e: ConnectionEvent) => void;
  /** Runs on every socket open, before `join` goes out; `send` already works (clock pings go first). */
  readonly onOpen?: () => void;
  readonly setTimer: (fn: () => void, ms: number) => Timer;
  readonly clearTimer: (handle: Timer) => void;
  /** [0, 1); defaults to Math.random. Spreads reconnects so clients don't stampede a restarted server. */
  readonly random?: () => number;
}

export interface Connection {
  /** False (and nothing sent) when the socket isn't open. */
  send(msg: ClientMessage): boolean;
  /** Closes for good (until resume); no reconnect, no `disconnected` event. */
  close(): void;
  /** Reconnect after close(), e.g. when a page comes back from bfcache. No-op if live or the room was full. */
  resume(): void;
}

const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 5000;
/** A socket with no snapshot by then is dropped and retried. */
export const HANDSHAKE_TIMEOUT_MS = 10_000;

/** One WebSocket per client. Re-joins after drops with capped, jittered exponential backoff; stops on room-full or close(). */
export function createConnection<Timer>(opts: ConnectionOptions<Timer>): Connection {
  const random = opts.random ?? Math.random;
  let socket: SocketLike | null = null;
  let open = false;
  let closed = false;
  let full = false;
  let attempts = 0;
  let retryTimer: Timer | null = null;
  let handshakeTimer: Timer | null = null;

  const clearHandshake = (): void => {
    if (handshakeTimer !== null) opts.clearTimer(handshakeTimer);
    handshakeTimer = null;
  };

  const connect = (): void => {
    opts.onEvent({ type: "connecting" });
    const s = opts.createSocket(opts.url);
    socket = s;
    handshakeTimer = opts.setTimer(() => {
      handshakeTimer = null;
      s.close(4000);
      // Some sockets stuck in CONNECTING never fire close; treat this as the drop.
      s.onclose?.();
    }, HANDSHAKE_TIMEOUT_MS);
    s.onopen = () => {
      open = true;
      opts.onOpen?.();
      s.send(JSON.stringify(opts.join));
    };
    s.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      const msg = parseServerMessage(ev.data);
      if (msg === null) return;
      if (msg.type === "snapshot") {
        attempts = 0;
        clearHandshake();
      }
      if (msg.type === "room-full") {
        full = true;
        clearHandshake();
      }
      opts.onEvent({ type: "message", msg });
    };
    s.onerror = null;
    s.onclose = () => {
      if (socket !== s) return;
      open = false;
      socket = null;
      clearHandshake();
      if (closed) return;
      opts.onEvent({ type: "disconnected" });
      if (full) return;
      const nominal = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempts);
      attempts++;
      retryTimer = opts.setTimer(() => {
        retryTimer = null;
        if (!closed && !full) connect();
      }, Math.round(nominal * (0.5 + random() / 2)));
    };
  };

  connect();

  return {
    send(msg) {
      if (!open || socket === null) return false;
      socket.send(JSON.stringify(msg));
      return true;
    },
    close() {
      closed = true;
      if (retryTimer !== null) opts.clearTimer(retryTimer);
      retryTimer = null;
      clearHandshake();
      socket?.close(1000);
    },
    resume() {
      if (full || socket !== null || retryTimer !== null) return;
      closed = false;
      attempts = 0;
      connect();
    },
  };
}
