// @mentions (OME-1531): stub for the red commit.
import type { Member, MemberId } from "@omega/shared";

export interface MentionQuery {
  readonly start: number;
  readonly query: string;
}

export const mentions = (_text: string, _nickname: string): boolean => false;
export const mentionQuery = (_value: string, _caret: number): MentionQuery | null => null;
export const mentionOptions = (_members: readonly Member[], _self: MemberId | null, _query: string): string[] => [];
export const completeMention = (value: string, _q: MentionQuery, _name: string): { value: string; caret: number } => ({ value, caret: 0 });
