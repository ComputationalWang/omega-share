// OME-1448: static furniture pieces are baked into the room shell, which is blitted every frame anyway, so a piece costs
// no fill of its own. Its live copy (in the depth-sorted object layer) draws only when the baked copy would be wrongly
// covered: by something drawn after the shell that is behind the piece and overlaps it (an avatar, a hat, the walk
// hover), or by a live piece behind it that overlaps it (so the closure). Drawing the live copy over the baked one is
// pixel-identical: the art is 1-bit alpha (assets/STYLE.md). A frame allocates nothing.

/** A static piece's box in stage px, its depth, and whether it always draws live (a loop, or under decor or a marker). */
export interface Piece {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  readonly z: number;
  readonly pinned: boolean;
}

export interface LivePieces {
  /** By piece index: draw the live copy this frame. Valid after `end()`. */
  readonly live: readonly boolean[];
  /** Start a frame: only the pinned pieces are live. */
  begin(): void;
  /** Something drawn over the shell at depth `z` (−Infinity: under every piece) covers this box. */
  cover(x0: number, y0: number, x1: number, y1: number, z: number): void;
  /** Close over the pieces in front of a live piece. */
  end(): void;
}

const overlaps = (a: Piece, x0: number, y0: number, x1: number, y1: number): boolean => a.x0 < x1 && x0 < a.x1 && a.y0 < y1 && y0 < a.y1;

export function livePieces(pieces: readonly Piece[]): LivePieces {
  const live = pieces.map(() => false);
  // For each piece, the pieces in front of it (same depth counts: the scene order decides then) that overlap it.
  const front = pieces.map((p, i) => pieces.flatMap((q, j) => (j !== i && q.z >= p.z && overlaps(q, p.x0, p.y0, p.x1, p.y1) ? [j] : [])));
  const stack = new Int32Array(pieces.length);
  let top = 0;
  const mark = (i: number): void => {
    if (live[i] === true) return;
    live[i] = true;
    stack[top++] = i;
  };
  return {
    live,
    begin() {
      top = 0;
      for (let i = 0; i < pieces.length; i++) live[i] = false;
      for (let i = 0; i < pieces.length; i++) if (pieces[i]?.pinned === true) mark(i);
    },
    cover(x0, y0, x1, y1, z) {
      for (let i = 0; i < pieces.length; i++) {
        const p = pieces[i];
        if (p !== undefined && p.z >= z && overlaps(p, x0, y0, x1, y1)) mark(i);
      }
    },
    end() {
      while (top > 0) {
        const ahead = front[stack[--top] ?? 0];
        if (ahead !== undefined) for (const j of ahead) mark(j);
      }
    },
  };
}
