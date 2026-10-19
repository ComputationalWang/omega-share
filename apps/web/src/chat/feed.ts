// What the chat log (log.ts) says for one view event (OME-594): chat from members, the lines the caption rail shows
// (playback, the control policy, my mute), joins and leaves, and the ADR 0030 removals. Read from the state before and after the event,
// so the log agrees with the reducer about what counts (a stale rev or a stranger's chat logs nothing).
import { gapLine, joinedLine, leftLine, removedLine, removedMeLine } from "../controls/sysline";
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
  // OME-1426: the readable record of a roll; the bubble over the roller is aria-hidden.
  if (msg.type === "rolled") {
    const who = next.room?.members.find((m) => m.id === msg.memberId);
    if (who === undefined) return [];
    return [{ kind: "system", line: { glyph: "everyone", actor: msg.memberId === next.self ? "You" : who.nickname, verb: `rolled ${String(msg.value)} (d${String(msg.sides)})`, time: null } }];
  }
  // OME-1454: the card goes with the poll, so the result is the log's line ("Poll: Next video? — A 3 · B 1").
  if (msg.type === "poll-closed") {
    const poll = prev.poll;
    if (poll === null || next.poll !== null) return [];
    return [{ kind: "system", line: { glyph: "everyone", actor: null, verb: `Poll: ${poll.question} — ${poll.options.map((o, i) => `${o} ${String(msg.counts[i] ?? 0)}`).join(" · ")}`, time: null } }];
  }
  if (msg.type === "member-left") {
    const who = prev.room?.members.find((m) => m.id === msg.memberId);
    if (who === undefined) return [];
    return [{ kind: "system", line: msg.reason === "kicked" ? removedLine(who.nickname) : leftLine(who.nickname) }];
  }
  // The reducer ignores a member it already has, so a repeat (a resume) never gets here: `next === prev` above.
  if (msg.type === "member-joined") return [{ kind: "system", line: joinedLine(msg.member.nickname) }];
  // A first join has no room yet; a snapshot while open changes nothing we said.
  if (msg.type === "snapshot") return prev.room !== null && prev.status !== "open" ? [{ kind: "system", line: gapLine() }] : [];
  // Any new caption-rail line (playback, policy, my mute) goes in the log too, without its rail id and expiry.
  const newest = next.syslines.at(-1);
  if (newest === undefined || prev.syslines.includes(newest)) return [];
  const { glyph, actor, verb, time, self } = newest;
  return [{ kind: "system", line: self === undefined ? { glyph, actor, verb, time } : { glyph, actor, verb, time, self } }];
}
