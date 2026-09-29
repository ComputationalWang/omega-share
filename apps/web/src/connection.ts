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
  readonly setTimer: (fn: () => void, ms: number) => Timer;
  readonly clearTimer: (handle: Timer) => void;
}

export interface Connection {
  /** False (and nothing sent) when the socket isn't open. */
  send(msg: ClientMessage): boolean;
  close(): void;
}

const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 5000;

/** One WebSocket per client. Re-joins after drops with capped exponential backoff; stops on room-full or close(). */
export function createConnection<Timer>(opts: ConnectionOptions<Timer>): Connection {
  let socket: SocketLike | null = null;
  let open = false;
  let stopped = false;
  let attempts = 0;
  let timer: Timer | null = null;

  const connect = (): void => {
    opts.onEvent({ type: "connecting" });
    const s = opts.createSocket(opts.url);
    socket = s;
    s.onopen = () => {
      open = true;
      s.send(JSON.stringify(opts.join));
    };
    s.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      const msg = parseServerMessage(ev.data);
      if (msg === null) return;
      if (msg.type === "snapshot") attempts = 0;
      if (msg.type === "room-full") stopped = true;
      opts.onEvent({ type: "message", msg });
    };
    s.onerror = null;
    s.onclose = () => {
      if (socket !== s) return;
      open = false;
      socket = null;
      opts.onEvent({ type: "disconnected" });
      if (stopped) return;
      const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempts);
      attempts++;
      timer = opts.setTimer(() => {
        timer = null;
        if (!stopped) connect();
      }, delay);
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
      stopped = true;
      if (timer !== null) opts.clearTimer(timer);
      timer = null;
      socket?.close(1000);
    },
  };
}
