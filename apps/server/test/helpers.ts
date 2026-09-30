import type { Server } from "bun";
import { parseServerMessage, type ServerMessage } from "@omega/shared";
import { startServer, type ServerOptions } from "../src/server";

export const SITE_ORIGIN = "http://localhost:5173";
export const EXTENSION_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const TIMEOUT_MS = 1000;

export interface TestServer {
  server: Server<unknown>;
  http: string;
  ws: (roomId?: string) => string;
}

export function start(opts: Partial<ServerOptions> = {}): TestServer {
  const server = startServer({ port: 0, hostname: "127.0.0.1", siteOrigin: SITE_ORIGIN, ...opts });
  const http = `http://127.0.0.1:${String(server.port)}`;
  return { server, http, ws: (roomId = "lobby") => `ws://127.0.0.1:${String(server.port)}/rooms/${roomId}/ws` };
}

type Of<T extends ServerMessage["type"]> = Extract<ServerMessage, { type: T }>;

/** A WebSocket test client that queues parsed server messages. */
export class Client {
  readonly socket: WebSocket;
  /** Every text frame as sent, before parsing (parsing strips unknown keys). */
  readonly raw: string[] = [];
  private readonly inbox: ServerMessage[] = [];
  private waiter: (() => void) | null = null;
  closed: Promise<CloseEvent>;

  constructor(url: string, origin?: string, headers: Record<string, string> = {}) {
    this.socket = new WebSocket(url, { headers: origin === undefined ? headers : { ...headers, Origin: origin } });
    this.socket.addEventListener("message", (e: MessageEvent) => {
      if (typeof e.data === "string") this.raw.push(e.data);
      const msg = typeof e.data === "string" ? parseServerMessage(e.data) : null;
      if (msg === null) throw new Error(`server sent an invalid frame: ${String(e.data)}`);
      this.inbox.push(msg);
      this.waiter?.();
    });
    this.closed = new Promise((resolve) => {
      this.socket.addEventListener("close", resolve);
    });
  }

  static async open(url: string, origin?: string, headers?: Record<string, string>): Promise<Client> {
    const c = new Client(url, origin, headers);
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
  static async join(
    url: string,
    nickname: string,
    avatar = 0,
    headers?: Record<string, string>,
  ): Promise<{ client: Client; snapshot: Of<"snapshot"> }> {
    const client = await Client.open(url, undefined, headers);
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
      const msg = this.inbox[i];
      if (msg !== undefined) {
        this.inbox.splice(0, i + 1);
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

  /** Asserts no message of `type` arrives within the next `ms`. */
  async none(type: ServerMessage["type"], ms = 100): Promise<void> {
    const from = this.inbox.length;
    await Bun.sleep(ms);
    if (this.inbox.slice(from).some((m) => m.type === type)) throw new Error(`unexpected ${type}`);
  }

  close(): void {
    this.socket.close();
  }
}

export interface ShareInit {
  roomId?: string;
  /** Sent as `Authorization: Bearer <token>`; omit for an anonymous share. */
  token?: string;
  origin?: string;
  headers?: Record<string, string>;
}

/** `POST /rooms/:id/share` with a JSON body. */
export function postShare(t: TestServer, body: string, init: ShareInit = {}): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json", ...init.headers };
  if (init.token !== undefined) headers["authorization"] = `Bearer ${init.token}`;
  if (init.origin !== undefined) headers["origin"] = init.origin;
  return fetch(`${t.http}/rooms/${init.roomId ?? "lobby"}/share`, { method: "POST", headers, body });
}

/** The member's share token; every M2 snapshot carries one. */
export function tokenOf(snapshot: Of<"snapshot">): string {
  if (snapshot.shareToken === undefined) throw new Error("snapshot has no shareToken");
  return snapshot.shareToken;
}
