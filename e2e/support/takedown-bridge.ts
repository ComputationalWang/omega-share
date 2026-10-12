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
  onText: ((text: string) => void) | null;
  onClose: ((closed: BridgeClose) => void) | null;
  sendText(text: string): void;
  destroy(): void;
}

/** Bridge exactly one browser connection to one upstream connection. */
export function takedownBridge<T extends BridgeSocket>(browser: BridgeBrowser, connect: () => Promise<T>, sockets: T[]): Promise<void> {
  return connect().then((sock) => {
    sockets.push(sock);
    sock.onText = (text) => {
      browser.send(text);
    };
    sock.onClose = (closed) => {
      void browser.close(closed);
    };
    browser.onMessage((message) => {
      if (typeof message === "string") sock.sendText(message);
    });
    browser.onClose(() => {
      sock.destroy();
    });
  });
}
