import type { ClientMessage } from "@omega/shared";
import type { SingleMessage } from "./connection";

type ChatLine = Extract<ClientMessage, { type: "chat" }>;

/** Chat lines the room hasn't answered yet (OME-2425): a socket that died unnoticed must not eat them. */
export interface ChatOutbox {
  /** Sends any message; a chat line is kept until the room answers it. */
  send(msg: ClientMessage): boolean;
  /** Feed every server message but the snapshot: my own echo or a `muted` answers lines. */
  onServer(msg: SingleMessage, self: string | null): void;
  /** After a rejoin's snapshot: the lines still unanswered go again. */
  resend(): void;
}

export function createChatOutbox(send: (msg: ClientMessage) => boolean): ChatOutbox {
  let pending: ChatLine[] = [];
  const out = (msg: ClientMessage): boolean => {
    if (!send(msg)) return false;
    if (msg.type === "chat") pending.push(msg);
    return true;
  };
  return {
    send: out,
    onServer(msg, self) {
      // The room handles lines in order: my echo answers its line and the earlier ones it refused (a rate-limit streak
      // refuses silently). A `rate_limited` may be another frame's, so it answers nothing; `muted` refuses every line in flight.
      if (msg.type === "error" && msg.code === "muted") pending = [];
      if (msg.type !== "chat" || msg.memberId !== self) return;
      const at = pending.findIndex((line) => line.text.trim().normalize("NFC") === msg.text);
      if (at >= 0) pending = pending.slice(at + 1);
    },
    resend() {
      const lines = pending;
      pending = [];
      for (const line of lines) if (!out(line)) pending.push(line);
    },
  };
}
