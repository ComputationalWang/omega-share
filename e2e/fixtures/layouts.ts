// Test room layouts (OME-278, OME-281). SET_G is valid (one TV, eight seat cells) and uses set (g) pieces only for its seats.
import type { RoomLayout } from "@omega/shared";

/** Two sofas and a couch take seats 0–5, then a wingback and a beanbag; plus a runner, a print, a bookcase and props. */
export const SET_G: RoomLayout = {
  furniture: [
    { kind: "tv", col: 0, row: 0, facing: "se" },
    { kind: "runner", col: 4, row: 4, facing: "ne", variant: 1 },
    { kind: "sofa", col: 2, row: 5, facing: "ne" },
    { kind: "sofa", col: 5, row: 2, facing: "nw", variant: 1 },
    { kind: "couch", col: 3, row: 7, facing: "nw" },
    { kind: "wingback", col: 1, row: 6, facing: "ne" },
    { kind: "beanbag", col: 7, row: 3, facing: "nw" },
    { kind: "frame", col: 3, row: 0, facing: "sw" },
    { kind: "bookshelf", col: 6, row: 0, facing: "sw" },
    { kind: "arclamp", col: 8, row: 8, facing: "sw" },
    { kind: "popcorn", col: 0, row: 9, facing: "se" },
  ],
};
/** Seat i of SET_G → the piece it sits on (its back/front frames). */
export const SET_G_SEAT_PIECE = ["sofa/velvet/ne", "sofa/velvet/ne", "sofa/navy/nw", "sofa/navy/nw", "couch/cream/nw", "couch/cream/nw", "wingback/ginger/ne", "beanbag/blush/nw"];

/** Catalogue v2 (OME-1113) with room-atlas kinds only: floor cushions ne nw se sw (seats 0–3), benches ne (4–5) and nw (6–7), every v2 decor piece. */
export const V2_SEATS: RoomLayout = {
  furniture: [
    { kind: "tv", col: 0, row: 0, facing: "se" },
    { kind: "floorcushion", col: 2, row: 5, facing: "ne" },
    { kind: "floorcushion", col: 5, row: 2, facing: "nw", variant: 1 },
    { kind: "floorcushion", col: 3, row: 7, facing: "se" },
    { kind: "floorcushion", col: 7, row: 3, facing: "sw" },
    { kind: "bench", col: 5, row: 6, facing: "ne" },
    { kind: "bench", col: 8, row: 5, facing: "nw", variant: 1 },
    { kind: "garland", col: 4, row: 0, facing: "sw" },
    { kind: "garland", col: 5, row: 0, facing: "sw", variant: 1 },
    { kind: "wallshelf", col: 0, row: 4, facing: "se" },
    { kind: "turntable", col: 0, row: 8, facing: "se" },
    { kind: "speaker", col: 1, row: 9, facing: "se" },
    { kind: "cat", col: 9, row: 9, facing: "sw", variant: 1 },
  ],
};
/** Seat i of V2_SEATS → its piece's frames. */
export const V2_SEATS_PIECE = ["floorcushion/mustard/ne", "floorcushion/teal/nw", "floorcushion/mustard/se", "floorcushion/mustard/sw", "bench/teal/ne", "bench/teal/ne", "bench/pink/nw", "bench/pink/nw"];
/** Benches facing se (seats 0–1) and sw (2–3), with four cushions to make eight seats. */
export const V2_BENCHES: RoomLayout = {
  furniture: [
    { kind: "tv", col: 0, row: 0, facing: "se" },
    { kind: "bench", col: 2, row: 5, facing: "se" },
    { kind: "bench", col: 5, row: 2, facing: "sw" },
    { kind: "floorcushion", col: 4, row: 7, facing: "ne" },
    { kind: "floorcushion", col: 7, row: 4, facing: "nw" },
    { kind: "floorcushion", col: 6, row: 8, facing: "se" },
    { kind: "floorcushion", col: 8, row: 6, facing: "sw" },
  ],
};
/** Seat i of V2_BENCHES → its piece's frames. */
export const V2_BENCHES_PIECE = ["bench/teal/se", "bench/teal/se", "bench/teal/sw", "bench/teal/sw", "floorcushion/mustard/ne", "floorcushion/mustard/nw", "floorcushion/mustard/se", "floorcushion/mustard/sw"];
