// Share callers that aren't the extension (OME-132): POST /rooms/:id/share needs `Authorization: Bearer <shareToken>`,
// and the token is minted at WebSocket `join`, sent only in that member's own snapshot (ADR 0015).
import { expect } from "@playwright/test";
import { request as httpRequest } from "node:http";
import type { APIRequestContext } from "@playwright/test";
import { parseServerMessage } from "@omega/shared";
import { URLS } from "./apps";

export interface ShareMember {
  readonly token: string;
  readonly close: () => void;
}

/** Joins `roomId` over a raw WebSocket and resolves with the member's share token once its snapshot arrives. */
export function joinForToken(roomId: string, nickname: string): Promise<ShareMember> {
  return new Promise<ShareMember>((resolve, reject) => {
    const ws = new WebSocket(`${URLS.server.replace(/^http/, "ws")}/rooms/${roomId}/ws`);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("no snapshot with a share token within 10 s"));
    }, 10_000);
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "join", nickname, avatar: 0 }));
    });
    ws.addEventListener("message", (ev: MessageEvent<unknown>) => {
      if (typeof ev.data !== "string") return;
      const msg = parseServerMessage(ev.data);
      if (msg?.type === "error") {
        clearTimeout(timer);
        ws.close();
        reject(new Error(`join refused: ${msg.code}`));
        return;
      }
      if (msg?.type !== "snapshot") return;
      clearTimeout(timer);
      if (msg.shareToken === undefined) {
        ws.close();
        reject(new Error("snapshot carried no shareToken"));
        return;
      }
      resolve({ token: msg.shareToken, close: () => { ws.close(); } });
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("websocket error"));
    });
  });
}

/** What callers read from a share reply; Playwright's APIResponse is one. */
export interface ShareReply {
  status(): number;
  json(): Promise<unknown>;
}

const SERVER = new URL(URLS.server);
const LOOPBACK_SERVER = ["localhost", "127.0.0.1"].includes(SERVER.hostname);
/** Playwright gives each worker slot an index; it keeps one worker's source addresses apart from another's. */
const PARALLEL_INDEX = Number(process.env["TEST_PARALLEL_INDEX"] ?? 0);
let shares = 0;

/**
 * A loopback source address no other share in this run has used (Linux routes all of 127/8 to lo). The share
 * limiter keys by client address (5 burst, 1 per 3 s), and helper shares are setup, not the limiter under test
 * (abuse.e2e.ts tests it). From their own addresses, parallel specs never queue on each other, and 127.0.0.1 is
 * left to the browser's shares: the extension popup's and the site's (OME-341).
 */
function sourceAddress(): string {
  const n = shares++;
  return `127.${String(10 + (PARALLEL_INDEX % 200))}.${String(Math.floor(n / 250) % 250)}.${String(1 + (n % 250))}`;
}

/** One POST to `path` on the loopback server, sent from `from`. */
function postFrom(from: string, path: string, token: string, url: string): Promise<ShareReply> {
  const data = JSON.stringify({ url });
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        // Not "localhost": it may resolve to ::1, which can't be reached from an IPv4 source.
        host: "127.0.0.1",
        port: SERVER.port,
        localAddress: from,
        method: "POST",
        path,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": Buffer.byteLength(data) },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (text += chunk));
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          resolve({ status: () => status, json: () => Promise.resolve(JSON.parse(text) as unknown) });
        });
      },
    );
    req.on("error", reject);
    req.end(data);
  });
}

/**
 * POSTs `url` to the room's share endpoint with `token`, retrying while a share limiter answers 429. Returns the
 * first non-429 response. On a loopback server each attempt comes from a fresh source address (see sourceAddress);
 * anywhere else (e2e:real, a tunnel) it goes through `request` from this machine's one address.
 */
export async function postShare(request: APIRequestContext, roomId: string, token: string, url: string): Promise<ShareReply> {
  const path = `/rooms/${roomId}/share`;
  const post = (): Promise<ShareReply> =>
    LOOPBACK_SERVER ? postFrom(sourceAddress(), path, token, url) : request.post(`${URLS.server}${path}`, { data: { url }, headers: { authorization: `Bearer ${token}` } });
  let res = await post();
  await expect
    .poll(async () => {
      if (res.status() === 429) res = await post();
      return res.status();
    }, { timeout: 20_000, intervals: [1_000] })
    .not.toBe(429);
  return res;
}
