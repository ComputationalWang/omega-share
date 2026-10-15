/**
 * Building blocks shared by the server load tools (perf/server-compare.ts, perf/server-soak.ts): starting any
 * server command under the env contract, sampling its /proc, a WebSocket client that can bind its source address,
 * and the small statistics helpers.
 */
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { Socket } from "node:net";

export const SITE_ORIGIN = "http://localhost:5173";
const CLK_TCK = 100;
/** apps/server/src/server.ts caps 50 sockets per address when not behind the proxy; stay under it. */
const PER_IP_USE = 40;

/** Nearest-rank percentile of an ascending array (same as relay-latency.ts). */
export function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

const kb = (text: string, key: string): number | null => {
  const m = new RegExp(`^${key}:\\s+(\\d+) kB$`, "m").exec(text);
  return m?.[1] === undefined ? null : Number(m[1]) * 1024;
};

/** /proc/<pid>/status → resident and peak-resident bytes. */
export function parseProcStatus(text: string): { rss: number; hwm: number } | null {
  const rss = kb(text, "VmRSS");
  const hwm = kb(text, "VmHWM");
  return rss === null || hwm === null ? null : { rss, hwm };
}

/** /proc/<pid>/stat → utime+stime in clock ticks. comm may hold spaces and parens, so split after the last ")". */
export function parseProcStat(text: string): { ticks: number } | null {
  const rest = text.slice(text.lastIndexOf(")") + 2).split(" ");
  const utime = Number(rest[11]);
  const stime = Number(rest[12]);
  return text.includes(")") && Number.isFinite(utime) && Number.isFinite(stime) ? { ticks: utime + stime } : null;
}

/** CPU % of one core over `elapsedMs` (can exceed 100 with threads). */
export function cpuPercent(ticks0: number, ticks1: number, elapsedMs: number): number {
  return elapsedMs <= 0 ? 0 : (((ticks1 - ticks0) * 1000) / CLK_TCK / elapsedMs) * 100;
}

/** Linux routes all of 127.0.0.0/8 to lo, and the source address of a connection is the destination: distinct IPs get distinct per-IP caps. */
export function loopbackAddrs(sockets: number, cap: number = PER_IP_USE): string[] {
  const n = Math.max(1, Math.ceil(sockets / cap));
  return Array.from({ length: n }, (_, i) => `127.0.0.${String(i + 1)}`);
}

export interface StartedServer {
  proc: ReturnType<typeof Bun.spawn>;
  port: number;
  /** The last 4000 bytes of stderr. */
  stderr: () => string;
}

/**
 * Runs `cmd` (a shell command that honours the env contract) and resolves once it prints its address.
 * `env` is merged over the process env; PORT defaults to 0 (the printed port is returned). `onStderr` gets every chunk.
 */
export async function startServer(cmd: string, env: Record<string, string>, onStderr?: (chunk: string) => void): Promise<StartedServer> {
  // `exec` makes the shell become the server, so the PID we sample is the server's.
  const proc = Bun.spawn(["sh", "-c", `exec ${cmd}`], { env: { ...process.env, PORT: "0", ...env }, stdout: "pipe", stderr: "pipe" });
  let err = "";
  void (async () => {
    const dec = new TextDecoder();
    for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
      const text = dec.decode(chunk, { stream: true });
      err = (err + text).slice(-4000);
      onStderr?.(text);
    }
  })();
  const dec = new TextDecoder();
  let out = "";
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const deadline = Date.now() + 15_000;
  for (;;) {
    const m = /server on https?:\/\/[^\s/:]+:(\d+)/.exec(out);
    if (m?.[1] !== undefined) {
      // Keep draining so a chatty server never blocks on a full pipe.
      void (async () => {
        while (!(await reader.read()).done);
      })();
      return { proc, port: Number(m[1]), stderr: () => err };
    }
    if (Date.now() > deadline) throw new Error("server did not print its address within 15 s");
    const { done, value } = await reader.read();
    if (done) throw new Error(`server exited before it listened: ${err.slice(-500)}`);
    out += dec.decode(value);
  }
}

export function readProc(pid: number): { rss: number; hwm: number; ticks: number } | null {
  try {
    const s = parseProcStatus(readFileSync(`/proc/${String(pid)}/status`, "utf8"));
    const t = parseProcStat(readFileSync(`/proc/${String(pid)}/stat`, "utf8"));
    return s === null || t === null ? null : { ...s, ...t };
  } catch {
    return null;
  }
}

export interface WsHandlers {
  open: () => void;
  text: (s: string) => void;
  /** `code` is the server's close-frame code, when it sent one. */
  close: (why: string, code?: number) => void;
}

/**
 * A minimal WebSocket client over node:http, because it can bind the source address (`localAddress`) and
 * Bun's WebSocket can't: the server caps sockets per source IP, so 500 clients need several 127.0.0.x sources
 * (as e2e/support/share.ts does). Text frames only, which is all the room protocol uses.
 */
export class WsConn {
  #socket: Socket | null = null;
  #buf: Buffer = Buffer.alloc(0);
  #closed = false;
  readonly #on: WsHandlers;
  constructor(port: number, from: string, path: string, on: WsHandlers, headers: Record<string, string> = {}) {
    this.#on = on;
    const req = httpRequest({
      host: "127.0.0.1",
      port,
      localAddress: from,
      path,
      headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": randomBytes(16).toString("base64"), origin: SITE_ORIGIN, ...headers },
    });
    req.on("upgrade", (_res, socket: Socket, head: Buffer) => {
      this.#socket = socket;
      socket.on("data", (d: Buffer) => {
        this.#read(d);
      });
      socket.on("close", () => {
        this.#end("socket closed");
      });
      socket.on("error", () => {
        this.#end("socket error");
      });
      this.#on.open();
      if (head.length > 0) this.#read(head);
    });
    req.on("response", (res) => {
      this.#end(`HTTP ${String(res.statusCode)}`);
    });
    req.on("error", (err) => {
      this.#end(err.message);
    });
    req.end();
  }

  #end(why: string, code?: number): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#on.close(why, code);
  }

  #read(d: Buffer): void {
    this.#buf = this.#buf.length === 0 ? d : Buffer.concat([this.#buf, d]);
    for (;;) {
      const b = this.#buf;
      if (b.length < 2) return;
      const len7 = (b[1] ?? 0) & 0x7f;
      const head = len7 === 126 ? 4 : len7 === 127 ? 10 : 2;
      if (b.length < head) return;
      const len = len7 === 126 ? b.readUInt16BE(2) : len7 === 127 ? Number(b.readBigUInt64BE(2)) : len7;
      if (b.length < head + len) return;
      const op = (b[0] ?? 0) & 0x0f;
      if (op === 1) this.#on.text(b.toString("utf8", head, head + len));
      else if (op === 8) this.#end("server close frame", len >= 2 ? b.readUInt16BE(head) : undefined);
      this.#buf = b.subarray(head + len);
    }
  }

  #frame(op: number, payload: Buffer): boolean {
    if (this.#socket === null || this.#closed) return false;
    // shortcut: client frames stay under 64 KiB (room messages are tiny), so no 8-byte length form.
    const big = payload.length > 125;
    const head = big ? 8 : 6;
    const out = Buffer.alloc(head + payload.length);
    out[0] = 0x80 | op;
    if (big) {
      out[1] = 0x80 | 126;
      out.writeUInt16BE(payload.length, 2);
    } else out[1] = 0x80 | payload.length;
    const mask = randomBytes(4);
    mask.copy(out, head - 4);
    for (let i = 0; i < payload.length; i++) out[head + i] = (payload[i] ?? 0) ^ (mask[i & 3] ?? 0);
    this.#socket.write(out);
    return true;
  }

  /** Sends a text frame; false when the socket is not open. */
  send(text: string): boolean {
    return this.#frame(1, Buffer.from(text));
  }

  /** Stops reading: the kernel buffers fill and the server sees a stalled reader. */
  pause(): void {
    this.#socket?.pause();
  }

  /** Drops the TCP connection without a close frame. */
  drop(): void {
    this.#socket?.destroy();
  }

  close(): void {
    this.#frame(8, Buffer.alloc(0));
    this.#socket?.end();
  }
}
