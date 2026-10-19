// OME-1448: which baked furniture pieces must also draw live this frame. Stub (red).

/** A static piece's box in stage px, its depth, and whether it always draws live. */
export interface Piece {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  readonly z: number;
  readonly pinned: boolean;
}

export interface LivePieces {
  readonly live: readonly boolean[];
  begin(): void;
  cover(x0: number, y0: number, x1: number, y1: number, z: number): void;
  end(): void;
}

export function livePieces(pieces: readonly Piece[]): LivePieces {
  const live = pieces.map(() => false);
  return { live, begin: () => undefined, cover: () => undefined, end: () => undefined };
}
