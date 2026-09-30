import type { Member, MemberId, PlaybackState } from "@omega/shared";

export type SyslineGlyph = "play" | "pause" | "seek";

/**
 * One chat system line, as data: the view renders `actor` in <b> and `time` in <time>,
 * all via textContent. `actor` null = no actor shown ("Video shared").
 */
export interface SystemLine {
  readonly glyph: SyslineGlyph;
  readonly actor: string | null;
  readonly verb: string;
  readonly time: string | null;
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

/** Plain-text form, for aria and tests. */
export function lineText(l: SystemLine): string {
  return [l.actor, l.verb, l.time].filter((x) => x !== null).join(" ");
}
