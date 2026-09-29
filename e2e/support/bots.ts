// Cheap room members: raw WebSockets opened from a page on the site origin (so the server's Origin check passes).
// Use them to fill seats or the room without paying for a full site client each.
import type { Browser, BrowserContext } from "@playwright/test";
import { URLS } from "./apps";

export interface BotSpec {
  readonly nickname: string;
  /** Seat to sit on after joining; omit to stay standing. */
  readonly seat?: number;
}

export interface Bots {
  /** How many bots got a snapshot (joined) before the first `room-full`. */
  readonly joined: number;
  /** True when a bot was turned away with `room-full`. */
  readonly sawRoomFull: boolean;
  readonly close: () => Promise<void>;
}

export function socketUrl(roomId: string): string {
  const u = new URL(URLS.server);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = `/rooms/${roomId}/ws`;
  return u.href;
}

/** Joins `specs` one by one; stops at the first `room-full`. Bots stay connected until `close()`. */
export async function spawnBots(browser: Browser, roomId: string, specs: readonly BotSpec[]): Promise<Bots> {
  const context: BrowserContext = await browser.newContext();
  const page = await context.newPage();
  await page.goto(URLS.web);
  const result = await page.evaluate(
    async ({ url, specs }) => {
      const kept: WebSocket[] = [];
      Object.assign(window, { omegaBots: kept });
      let joined = 0;
      for (const spec of specs) {
        const ws = new WebSocket(url);
        const outcome = await new Promise<"joined" | "full" | "closed">((resolve) => {
          ws.addEventListener("open", () => {
            ws.send(JSON.stringify({ type: "join", nickname: spec.nickname, avatar: joined % 4 }));
          });
          ws.addEventListener("message", (ev: MessageEvent<unknown>) => {
            const msg: unknown = typeof ev.data === "string" ? JSON.parse(ev.data) : null;
            const type = typeof msg === "object" && msg !== null && "type" in msg ? msg.type : null;
            if (type === "snapshot") resolve("joined");
            else if (type === "room-full") resolve("full");
          });
          ws.addEventListener("close", () => {
            resolve("closed");
          });
        });
        if (outcome !== "joined") return { joined, sawRoomFull: outcome === "full" };
        joined++;
        kept.push(ws);
        if (spec.seat !== undefined) ws.send(JSON.stringify({ type: "sit", seat: spec.seat }));
      }
      return { joined, sawRoomFull: false };
    },
    { url: socketUrl(roomId), specs },
  );
  return { ...result, close: () => context.close() };
}

/** The room as the server sees it: joins as a throwaway observer, then leaves. Returns the raw snapshot frame. */
export async function rawSnapshot(browser: Browser, roomId: string): Promise<string> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(URLS.web);
    return await page.evaluate(
      (url) =>
        new Promise<string>((resolve, reject) => {
          const ws = new WebSocket(url);
          ws.addEventListener("open", () => {
            ws.send(JSON.stringify({ type: "join", nickname: "observer", avatar: 0 }));
          });
          ws.addEventListener("message", (ev: MessageEvent<unknown>) => {
            if (typeof ev.data !== "string" || !ev.data.includes('"snapshot"')) return;
            ws.close();
            resolve(ev.data);
          });
          ws.addEventListener("close", () => {
            reject(new Error("closed before snapshot"));
          });
        }),
      socketUrl(roomId),
    );
  } finally {
    await context.close();
  }
}
