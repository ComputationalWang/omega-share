import type { Hair, Member, MemberId } from "@omega/shared";

export function autoHair(_members: readonly Pick<Member, "id" | "avatar" | "hair">[], _self: MemberId, _earlier: ReadonlySet<MemberId>, _hairs: number): Hair | null {
  return null;
}
