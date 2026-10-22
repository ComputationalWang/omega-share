// A room member on a raw WebSocket (OME-1644), for specs that assert on the wire: send any frame, valid or not,
// and wait for what the server answers or how it closes. Node's own WebSocket, like share.ts `joinForToken`.
import { parseServerMessage, type MemberId, type ServerMessage } from "@omega/shared";
import { URLS } from "./apps";

export type Of<T extends ServerMessage["type"]> = Extract<ServerMessage, { type: T }>;

export interface Closed {
  readonly code: number;
  readonly reason: string;
}

export interface JoinFields {
  readonly inviteKey?: string;
  readonly ownerToken?: string;
}

export class WsMember {
  /** Every parsed frame, in arrival order. */
  readonly frames: ServerMessage[] = [];
  closed: Closed | null = null;
  readonly #ws: WebSocket;
  #waiters: (() => void)[] = [];

  private constructor(
    ws: WebSocket,
    readonly self: MemberId,
    readonly snapshot: Of<"snapshot">,
  ) {
    this.#ws = ws;
  }

  /** Joins `roomId` and resolves once its snapshot arrives; rejects on an `error` or a close first. */
  static join(roomId: string, nickname: string, fields: JoinFields = {}): Promise<WsMember> {
    const ws = new WebSocket(`${URLS.server.replace(/^http/, "ws")}/rooms/${roomId}/ws`);
    return new Promise((resolve, reject) => {
      let member: WsMember | null = null;
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`${nickname}: no snapshot within 10 s`));
      }, 10_000);
      ws.addEventListener("open", () => {
        // A suffix per join: a retry or a reused local server finds the last attempt's member still held (nickname_taken).
        const unique = `${nickname.slice(0, 14)}-${Math.random().toString(36).slice(2, 7)}`;
        ws.send(JSON.stringify({ type: "join", nickname: unique, avatar: 0, ...fields }));
      });
      ws.addEventListener("message", (ev: MessageEvent<unknown>) => {
        const msg = typeof ev.data === "string" ? parseServerMessage(ev.data) : null;
        if (msg === null) return;
        if (member !== null) {
          member.frames.push(msg);
          member.#wake();
          return;
        }
        if (msg.type === "error") {
          clearTimeout(timer);
          ws.close();
          reject(new Error(`${nickname}: join refused: ${msg.code}`));
        } else if (msg.type === "snapshot") {
          clearTimeout(timer);
          member = new WsMember(ws, msg.self, msg);
          resolve(member);
        }
      });
      ws.addEventListener("close", (ev: CloseEvent) => {
        clearTimeout(timer);
        if (member === null) {
          reject(new Error(`${nickname}: closed ${String(ev.code)} before the snapshot`));
          return;
        }
        member.closed = { code: ev.code, reason: ev.reason };
        member.#wake();
      });
    });
  }

  /** Sends `msg` as JSON, or a string as it is (malformed frames). */
  send(msg: unknown): void {
    this.#ws.send(typeof msg === "string" ? msg : JSON.stringify(msg));
  }

  /** The first frame of `type` from index `from` on that passes `ok`, waiting up to `timeoutMs`. */
  next<T extends ServerMessage["type"]>(type: T, ok: (m: Of<T>) => boolean = () => true, from = 0, timeoutMs = 5_000): Promise<Of<T>> {
    const find = (): Of<T> | undefined =>
      this.frames.slice(from).find((m): m is Of<T> => m.type === type && ok(m as Of<T>));
    return this.#until(find, `${type} within ${String(timeoutMs)} ms`, timeoutMs);
  }

  /** Resolves with the close once the server has closed the socket. */
  whenClosed(timeoutMs = 10_000): Promise<Closed> {
    return this.#until(() => this.closed ?? undefined, `a close within ${String(timeoutMs)} ms`, timeoutMs);
  }

  close(): void {
    this.#ws.close();
  }

  #wake(): void {
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const w of waiters) w();
  }

  #until<R>(get: () => R | undefined, what: string, timeoutMs: number): Promise<R> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`no ${what}`));
      }, timeoutMs);
      const check = (): void => {
        const got = get();
        if (got === undefined) {
          this.#waiters.push(check);
          return;
        }
        clearTimeout(timer);
        resolve(got);
      };
      check();
    });
  }
}
