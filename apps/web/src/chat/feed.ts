// What the chat log (log.ts) says for one view event (OME-594): chat from members, the lines the caption rail shows
// (playback, the control policy, my mute), and the ADR 0030 removals. Read from the state before and after the event,
// so the log agrees with the reducer about what counts (a stale rev or a stranger's chat logs nothing).
import { removedLine, removedMeLine } from "../controls/sysline";
import type { ViewEvent, ViewState } from "../state";
import type { ChatLogEntry } from "./log";

export function logEntries(prev: ViewState, next: ViewState, event: ViewEvent): ChatLogEntry[] {
  if (event.type === "kicked") return prev.status === "kicked" ? [] : [{ kind: "system", line: removedMeLine() }];
  if (event.type !== "server" || next === prev) return [];
  const msg = event.msg;
  if (msg.type === "chat") {
    const who = next.room?.members.find((m) => m.id === msg.memberId);
    return who === undefined ? [] : [{ kind: "chat", nickname: who.nickname, text: msg.text, self: msg.memberId === next.self }];
  }
  if (msg.type === "member-left") {
    const who = prev.room?.members.find((m) => m.id === msg.memberId);
    return msg.reason === "kicked" && who !== undefined ? [{ kind: "system", line: removedLine(who.nickname) }] : [];
  }
  if (msg.type === "snapshot") return [];
  // Any new caption-rail line (playback, policy, my mute) goes in the log too, without its rail id and expiry.
  const newest = next.syslines.at(-1);
  if (newest === undefined || prev.syslines.includes(newest)) return [];
  const { glyph, actor, verb, time, self } = newest;
  return [{ kind: "system", line: self === undefined ? { glyph, actor, verb, time } : { glyph, actor, verb, time, self } }];
}
