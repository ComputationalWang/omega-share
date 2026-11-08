import type { ClientMessage } from "@omega/shared";
import type { SingleMessage } from "./connection";

type ChatLine = Extract<ClientMessage, { type: "chat" }>;

/** Chat lines the room hasn't answered yet (OME-2425): a socket that died unnoticed must not eat them. */
export interface ChatOutbox {
  /** Sends any message; a chat line is kept until the room answers it. */
  send(msg: ClientMessage): boolean;
  /** Feed every server message but the snapshot: my own echo or a refusal answers the oldest line. */
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
      // The server answers each line in order, with the echo or with `muted` / `rate_limited`.
      // shortcut: a rate_limited for another message kind (an emote) also answers a line; a line lost to that and a drop in the same moment isn't resent.
      const answered = (msg.type === "chat" && msg.memberId === self) || (msg.type === "error" && (msg.code === "muted" || msg.code === "rate_limited"));
      if (answered) pending.shift();
    },
    resend() {
      const lines = pending;
      pending = [];
      for (const line of lines) if (!out(line)) pending.push(line);
    },
  };
}
