// Share callers that aren't the extension (OME-132): POST /rooms/:id/share needs `Authorization: Bearer <shareToken>`,
// and the token is minted at WebSocket `join`, sent only in that member's own snapshot (ADR 0015).
import { expect } from "@playwright/test";
import type { APIRequestContext, APIResponse } from "@playwright/test";
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

/**
 * POSTs `url` to the room's share endpoint with `token`, retrying while the per-IP share limiter answers 429
 * (5 burst, 1 per 3 s, shared by every spec). Returns the first non-429 response.
 */
export async function postShare(request: APIRequestContext, roomId: string, token: string, url: string): Promise<APIResponse> {
  const endpoint = `${URLS.server}/rooms/${roomId}/share`;
  const post = () => request.post(endpoint, { data: { url }, headers: { authorization: `Bearer ${token}` } });
  let res = await post();
  await expect
    .poll(async () => {
      if (res.status() === 429) res = await post();
      return res.status();
    }, { timeout: 20_000, intervals: [1_000] })
    .not.toBe(429);
  return res;
}
