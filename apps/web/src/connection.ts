import { CLOSE_CODES, RATE_LIMITED_RECONNECT_MS, parseServerMessage, type ClientMessage, type ServerMessage } from "@omega/shared";

/** The part of `WebSocket` we use, so tests can fake it. */
export interface SocketLike {
  send(data: string): void;
  close(code?: number): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { readonly code: number }) => void) | null;
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
  /** Reconnect after close(), e.g. when a page comes back from bfcache. No-op if live, or the room was full or refused the join. */
  resume(): void;
}

const BACKOFF_BASE_MS = 500;
export const BACKOFF_MAX_MS = 5000;
/** A socket with no snapshot by then is dropped and retried. */
export const HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * One WebSocket per client. Re-joins after drops with capped, jittered exponential backoff and acts on the
 * close codes (ADR 0016 §5). Stops on room-full, on a refused join (`nickname_taken`, `too_many_members`:
 * rejoining with the same name can't succeed) or close().
 */
export function createConnection<Timer>(opts: ConnectionOptions<Timer>): Connection {
  const random = opts.random ?? Math.random;
  let socket: SocketLike | null = null;
  let open = false;
  let closed = false;
  /** Room full or join refused: never reconnect, not even on resume(). */
  let stopped = false;
  let attempts = 0;
  /** Set when this socket's join was rate-limited: the reconnect waits at least this long. */
  let retryAfter: number | null = null;
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
    let joined = false;
    handshakeTimer = opts.setTimer(() => {
      handshakeTimer = null;
      s.close(CLOSE_CODES.HANDSHAKE_TIMEOUT);
      // Some sockets stuck in CONNECTING never fire close; treat this as the drop.
      s.onclose?.({ code: CLOSE_CODES.HANDSHAKE_TIMEOUT });
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
        joined = true;
        attempts = 0;
        clearHandshake();
      }
      if (msg.type === "room-full") {
        stopped = true;
        clearHandshake();
      }
      opts.onEvent({ type: "message", msg });
      if (msg.type !== "error" || joined) return;
      // A refused join leaves the socket open and unjoined (ADR 0016 §4); drop it rather than wait for 4001.
      if (msg.code === "nickname_taken" || msg.code === "too_many_members") {
        stopped = true;
        s.close(1000);
      } else if (msg.code === "rate_limited") {
        retryAfter = msg.retryAfterMs ?? RATE_LIMITED_RECONNECT_MS;
        s.close(1000);
      }
    };
    s.onerror = null;
    s.onclose = (ev) => {
      if (socket !== s) return;
      open = false;
      socket = null;
      clearHandshake();
      if (closed) return;
      opts.onEvent({ type: "disconnected" });
      if (ev.code === CLOSE_CODES.ROOM_FULL) stopped = true;
      if (stopped) return;
      const delay = retryDelay(ev.code);
      retryAfter = null;
      retryTimer = opts.setTimer(() => {
        retryTimer = null;
        if (!closed && !stopped) connect();
      }, delay);
    };
  };

  /** Close code → wait before the next attempt. Everything we can't read (1006 and friends) is a network drop. */
  const retryDelay = (code: number): number => {
    const nominal = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempts);
    attempts++;
    if (code === CLOSE_CODES.RATE_LIMITED) return RATE_LIMITED_RECONNECT_MS;
    if (code === CLOSE_CODES.BAD_MESSAGES) return BACKOFF_MAX_MS;
    const backoff = Math.round(nominal * (0.5 + random() / 2));
    // Server-paced: never sooner than it asked, never sooner than the backoff, so this can't become a loop.
    return retryAfter === null ? backoff : Math.max(retryAfter, nominal);
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
      if (stopped || socket !== null || retryTimer !== null) return;
      closed = false;
      attempts = 0;
      connect();
    },
  };
}
