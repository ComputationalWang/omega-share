// Theme decor on the classic room's wall frames (OME-1186). Stub.
import type { Scene } from "../furniture";

export interface DecorPiece {
  readonly key: string;
  readonly on: string;
}

export function decorSprites(_scene: Scene, _decor: readonly DecorPiece[]): { key: string; x: number; y: number }[] {
  return [];
}
