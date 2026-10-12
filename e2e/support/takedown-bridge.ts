/** Public callbacks used by the M7 browser route and its raw upstream socket. */
export interface BridgeClose {
  readonly code: number;
  readonly reason: string;
}

export interface BridgeBrowser {
  send(message: string): void;
  close(options: BridgeClose): Promise<void>;
  onMessage(callback: (message: string | Buffer) => void): void;
  onClose(callback: () => void): void;
}

export interface BridgeSocket {
  readonly closed: BridgeClose | null;
  onText: ((text: string) => void) | null;
  onClose: ((closed: BridgeClose) => void) | null;
  sendText(text: string): void;
  destroy(): void;
}

/** Bridge exactly one browser connection to one upstream connection. */
export function takedownBridge<T extends BridgeSocket>(browser: BridgeBrowser, connect: () => Promise<T>, sockets: T[]): Promise<void> {
  let upstream: T | undefined;
  let ended = false;
  const pending: string[] = [];
  const closeBrowser = (closed: BridgeClose): Promise<void> => {
    ended = true;
    pending.length = 0;
    // A disposed browser route can reject close during test teardown.
    return browser.close(closed).catch(() => undefined);
  };
  // Playwright opens the browser route when its handler returns. Messages sent
  // before onMessage is installed are discarded, so register before upgrading.
  browser.onMessage((message) => {
    if (ended || typeof message !== "string") return;
    if (upstream === undefined) pending.push(message);
    else upstream.sendText(message);
  });
  browser.onClose(() => {
    ended = true;
    pending.length = 0;
    upstream?.destroy();
  });
  return connect().then(async (sock) => {
    sockets.push(sock);
    upstream = sock;
    if (ended) {
      sock.destroy();
      return;
    }
    sock.onText = (text) => {
      if (!ended) browser.send(text);
    };
    sock.onClose = (closed) => {
      if (!ended) void closeBrowser(closed);
    };
    // An upstream refusal can be in the HTTP upgrade's first frame.
    if (sock.closed !== null) {
      await closeBrowser(sock.closed);
      return;
    }
    for (const message of pending) sock.sendText(message);
    pending.length = 0;
  }).catch(async () => {
    upstream?.destroy();
    if (!ended) await closeBrowser({ code: 1011, reason: "test bridge upstream connection failed" });
  });
}
