import type { Server } from "bun";
import { parseServerMessage, type ServerMessage } from "@omega/shared";
import { startServer } from "../src/server";

export const SITE_ORIGIN = "http://localhost:5173";
export const EXTENSION_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const TIMEOUT_MS = 1000;

export interface TestServer {
  server: Server<unknown>;
  http: string;
  ws: (roomId?: string) => string;
}

export function start(): TestServer {
  const server = startServer({ port: 0, hostname: "127.0.0.1", siteOrigin: SITE_ORIGIN });
  const http = `http://127.0.0.1:${String(server.port)}`;
  return { server, http, ws: (roomId = "lobby") => `ws://127.0.0.1:${String(server.port)}/rooms/${roomId}/ws` };
}

type Of<T extends ServerMessage["type"]> = Extract<ServerMessage, { type: T }>;

/** A WebSocket test client that queues parsed server messages. */
export class Client {
  readonly socket: WebSocket;
  private readonly inbox: ServerMessage[] = [];
  private waiter: (() => void) | null = null;
  closed: Promise<CloseEvent>;

  constructor(url: string, origin?: string) {
    this.socket = origin === undefined ? new WebSocket(url) : new WebSocket(url, { headers: { Origin: origin } });
    this.socket.addEventListener("message", (e: MessageEvent) => {
      const msg = typeof e.data === "string" ? parseServerMessage(e.data) : null;
      if (msg === null) throw new Error(`server sent an invalid frame: ${String(e.data)}`);
      this.inbox.push(msg);
      this.waiter?.();
    });
    this.closed = new Promise((resolve) => {
      this.socket.addEventListener("close", resolve);
    });
  }

  static async open(url: string, origin?: string): Promise<Client> {
    const c = new Client(url, origin);
    await new Promise<void>((resolve, reject) => {
      c.socket.addEventListener("open", () => {
        resolve();
      });
      c.socket.addEventListener("error", () => {
        reject(new Error("socket error"));
      });
    });
    return c;
  }

  /** Opens and joins; resolves with the snapshot. */
  static async join(url: string, nickname: string, avatar = 0): Promise<{ client: Client; snapshot: Of<"snapshot"> }> {
    const client = await Client.open(url);
    client.send({ type: "join", nickname, avatar });
    return { client, snapshot: await client.next("snapshot") };
  }

  send(msg: unknown): void {
    this.socket.send(typeof msg === "string" ? msg : JSON.stringify(msg));
  }

  /** Next message of `type`; earlier messages of other types are discarded. */
  async next<T extends ServerMessage["type"]>(type: T, timeoutMs = TIMEOUT_MS): Promise<Of<T>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const i = this.inbox.findIndex((m) => m.type === type);
      if (i !== -1) {
        const [msg] = this.inbox.splice(0, i + 1).slice(-1);
        return msg as Of<T>;
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timed out waiting for ${type}`);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, left);
        this.waiter = () => {
          clearTimeout(t);
          resolve();
        };
      });
      this.waiter = null;
    }
  }

  /** Asserts no message of `type` arrives within `ms`. */
  async none(type: ServerMessage["type"], ms = 100): Promise<void> {
    await Bun.sleep(ms);
    if (this.inbox.some((m) => m.type === type)) throw new Error(`unexpected ${type}`);
  }

  close(): void {
    this.socket.close();
  }
}
