import type { ClientMessage } from "@omega/shared";
import type { SingleMessage } from "./connection";

export interface ChatOutbox {
  send(msg: ClientMessage): boolean;
  onServer(msg: SingleMessage, self: string | null): void;
  resend(): void;
}

export function createChatOutbox(send: (msg: ClientMessage) => boolean): ChatOutbox {
  return { send, onServer: () => undefined, resend: () => undefined };
}
