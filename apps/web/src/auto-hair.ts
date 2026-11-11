// OME-2559: two sitters on the same avatar and hair read as one head from behind. An auto guest (no saved avatar or
// hair) whose look an earlier member already wears takes the first hair nobody on that avatar wears, and sends it as
// `set-hair`. Only the later joiner moves: the server orders joins, so every pair agrees on who that is.
import type { Hair, Member, MemberId } from "@omega/shared";

/** The hair `self` should switch to, or null to keep theirs (no clash with an earlier member, or every hair taken). */
export function autoHair(members: readonly Pick<Member, "id" | "avatar" | "hair">[], self: MemberId, earlier: ReadonlySet<MemberId>, hairs: number): Hair | null {
  const me = members.find((m) => m.id === self);
  if (me === undefined) return null;
  const mine = me.hair ?? 0;
  const same = members.filter((m) => m.id !== self && m.avatar === me.avatar);
  if (!same.some((m) => earlier.has(m.id) && (m.hair ?? 0) === mine)) return null;
  const taken = new Set(same.map((m) => m.hair ?? 0));
  for (let h = 0; h < hairs; h++) if (!taken.has(h)) return h;
  return null;
}
