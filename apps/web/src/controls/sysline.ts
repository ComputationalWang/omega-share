import type { ControlPolicy, Member, MemberId, PlaybackState } from "@omega/shared";

export type SyslineGlyph = "play" | "pause" | "seek" | "remote" | "chat-mute" | "host";

/**
 * One chat system line, as data: the view renders `actor` in <b> and `time` in <time>,
 * all via textContent. `actor` null = no actor shown ("Video shared").
 */
export interface SystemLine {
  readonly glyph: SyslineGlyph;
  readonly actor: string | null;
  readonly verb: string;
  readonly time: string | null;
  /** Only I am told (the mustard "only you" bar, set j): my own mute. */
  readonly self?: boolean;
}

/** `12:30`, `1:02:45`. Anything that isn't a finite, non-negative number reads as 0:00. */
export function formatClock(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${String(h)}:${String(m).padStart(2, "0")}:${s}` : `${String(m)}:${s}`;
}

function actorName(by: MemberId | null, members: readonly Member[], self: MemberId | null): string {
  if (by === null) return "Someone";
  if (by === self) return "You";
  return members.find((m) => m.id === by)?.nickname ?? "Someone";
}

/** What a playback change says in chat: "Ana paused", "Ben skipped to 12:30", "Video shared". */
export function systemLine(pb: PlaybackState, members: readonly Member[], self: MemberId | null): SystemLine | null {
  switch (pb.action) {
    case "play":
      return { glyph: "play", actor: actorName(pb.by, members, self), verb: "pressed play", time: null };
    case "pause":
      return { glyph: "pause", actor: actorName(pb.by, members, self), verb: "paused", time: null };
    case "seek":
      return { glyph: "seek", actor: actorName(pb.by, members, self), verb: "skipped to", time: formatClock(pb.position) };
    case "load":
      return pb.by === null
        ? { glyph: "play", actor: null, verb: "Video shared", time: null }
        : { glyph: "play", actor: actorName(pb.by, members, self), verb: "shared a video", time: null };
  }
}

/** The room's control policy changed (ADR 0030): "Only the host controls playback now", "Ana gave the remote to everyone". */
export function policyLine(policy: ControlPolicy, by: MemberId, members: readonly Member[], self: MemberId | null): SystemLine {
  return policy === "owner"
    ? { glyph: "remote", actor: null, verb: "Only the host controls playback now", time: null }
    : { glyph: "remote", actor: actorName(by, members, self), verb: "gave the remote to everyone", time: null };
}

/** The owner muted or unmuted my chat (ADR 0030). Only I see it. */
export function mutedLine(muted: boolean): SystemLine {
  return muted
    ? { glyph: "chat-mute", actor: "The host", verb: "muted your chat. You can still watch and emote.", time: null, self: true }
    : { glyph: "chat-mute", actor: "The host", verb: "unmuted your chat", time: null, self: true };
}

/** Someone the host removed (ADR 0030 §2, `member-left { reason: "kicked" }`): everyone left in the room sees it. */
export function removedLine(nickname: string): SystemLine {
  return { glyph: "host", actor: nickname, verb: "was removed by the host", time: null };
}

/** The host removed me (4005). Only I see it. */
export function removedMeLine(): SystemLine {
  return { glyph: "host", actor: "The host", verb: "removed you from the room", time: null, self: true };
}

/** Plain-text form, for aria and tests. */
export function lineText(l: SystemLine): string {
  return [l.actor, l.verb, l.time].filter((x) => x !== null).join(" ");
}
