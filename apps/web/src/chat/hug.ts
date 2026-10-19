import type { FloorCell, Member, MemberId } from "@omega/shared";
import type { ViewState } from "../state";

export type MemberMatch = { readonly type: "match"; readonly id: MemberId; readonly nickname: string } | { readonly type: "none" } | { readonly type: "ambiguous" };

export interface PendingHug {
  readonly target: MemberId;
  readonly cell: FloorCell;
}

// Red stubs (OME-1453).
export const matchMember: (members: readonly Member[], self: MemberId | null, name: string) => MemberMatch = () => ({ type: "none" });
export const hugStep: (prev: ViewState, next: ViewState, hug: PendingHug) => "arrived" | "cancel" | null = () => null;
