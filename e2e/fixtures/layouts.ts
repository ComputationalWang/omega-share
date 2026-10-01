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
