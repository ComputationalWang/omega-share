import { describe, expect, test } from "bun:test";
import { livePieces, type Piece } from "../src/live-pieces";

// OME-1448: static furniture is baked into the room shell; a piece's live copy draws only where its baked copy would be
// wrongly covered: by something behind it that overlaps it, or by a live piece behind it that overlaps it.

const piece = (x0: number, y0: number, x1: number, y1: number, z: number, pinned = false): Piece => ({ x0, y0, x1, y1, z, pinned });
const frame = (pieces: readonly Piece[], covers: readonly (readonly [number, number, number, number, number])[]): boolean[] => {
  const l = livePieces(pieces);
  l.begin();
  for (const [x0, y0, x1, y1, z] of covers) l.cover(x0, y0, x1, y1, z);
  l.end();
  return [...l.live];
};

describe("livePieces", () => {
  test("with nothing over them, only pinned pieces draw live", () => {
    expect(frame([piece(0, 0, 10, 10, 5), piece(20, 0, 30, 10, 6, true)], [])).toEqual([false, true]);
  });

  test("an avatar behind a piece and overlapping it makes it live; one in front of it, or off it, does not", () => {
    const pieces = [piece(0, 0, 10, 10, 5)];
    expect(frame(pieces, [[5, 5, 15, 15, 4]])).toEqual([true]);
    expect(frame(pieces, [[5, 5, 15, 15, 6]])).toEqual([false]);
    expect(frame(pieces, [[11, 0, 20, 10, 4]])).toEqual([false]);
  });

  test("an avatar at the piece's own depth keeps it live (the scene order decides, as before)", () => {
    expect(frame([piece(0, 0, 10, 10, 5)], [[5, 5, 15, 15, 5]])).toEqual([true]);
  });

  test("boxes that only touch don't overlap", () => {
    expect(frame([piece(0, 0, 10, 10, 5)], [[10, 0, 20, 10, 1]])).toEqual([false]);
  });

  test("something under every piece (the walk hover) makes each piece it touches live", () => {
    expect(frame([piece(0, 0, 10, 10, 5), piece(30, 0, 40, 10, 2)], [[5, 5, 15, 15, -Infinity]])).toEqual([true, false]);
  });

  test("a piece in front of a live piece and overlapping it goes live too, transitively; one behind it stays baked", () => {
    const pieces = [
      piece(0, 0, 10, 10, 5), // live: the avatar behind it
      piece(8, 0, 18, 10, 6), // in front of 0, overlaps it
      piece(16, 0, 26, 10, 7), // in front of 1 only
      piece(-8, 0, 2, 10, 4), // behind 0, overlaps it
      piece(40, 0, 50, 10, 9), // apart
    ];
    expect(frame(pieces, [[4, 0, 6, 4, 1]])).toEqual([true, true, true, false, false]);
  });

  test("a pinned piece makes the pieces in front of it live", () => {
    expect(frame([piece(0, 0, 10, 10, 5, true), piece(5, 0, 15, 10, 6), piece(5, 0, 15, 10, 4)], [])).toEqual([true, true, false]);
  });

  test("each frame starts over", () => {
    const l = livePieces([piece(0, 0, 10, 10, 5)]);
    l.begin();
    l.cover(0, 0, 5, 5, 1);
    l.end();
    expect([...l.live]).toEqual([true]);
    l.begin();
    l.end();
    expect([...l.live]).toEqual([false]);
  });
});
