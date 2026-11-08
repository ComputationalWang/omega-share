// Rooms wave 26 (OME-2439, concepts OME-2434): Stage Door and Reef Tunnel as the concepts' tables place them. The
// contract and the comparison corpus hold these; the shipped presets take them over (OME-2441).

import type { Facing, FurnitureKind } from "../src/index";

interface Piece {
  readonly kind: FurnitureKind;
  readonly col: number;
  readonly row: number;
  readonly facing: Facing;
  readonly variant?: number;
}
const p = (kind: FurnitureKind, col: number, row: number, facing: Facing, variant?: number): Piece => ({ kind, col, row, facing, ...(variant === undefined ? {} : { variant }) });

/** Partition colours (variants): 0 solid, 1 glass, 2 panel, 3 panelglass, then wave 26's. */
const VELVET = 4, WINGS = 5, TANK = 6, TUNNEL = 7;

/** A column partition (axis `col` at 4, facing se); the stage door is the gap at (4, 7). */
export const STAGE_DOOR = {
  shell: "stage-door",
  furniture: [
    ...[0, 1, 8, 9].map((row) => p("partition", 4, row, "se", VELVET)),
    ...[2, 3, 4, 5, 6].map((row) => p("partition", 4, row, "se", WINGS)),
    // The stage, cols 5–9.
    p("stage", 6, 0, "sw"),
    p("projector", 6, 0, "sw"),
    p("curtain", 5, 0, "sw"),
    p("curtain", 9, 0, "sw"),
    p("tripod", 7, 8, "ne"),
    p("beanbag", 6, 4, "ne"),
    p("beanbag", 8, 4, "ne", 1),
    p("sidetable", 7, 5, "se"),
    p("stool", 6, 6, "ne", 1),
    p("stool", 8, 6, "ne", 1),
    p("arclamp", 9, 6, "se"),
    p("monstera", 5, 9, "se"),
    // The green room, cols 0–3.
    p("vanity", 0, 8, "se"),
    p("vanity", 0, 9, "se"),
    p("rack", 1, 6, "sw"),
    p("couch", 1, 3, "se", 1),
    p("wingback", 2, 1, "se"),
    p("pouf", 3, 2, "se", 1),
    p("minibar", 1, 0, "sw", 1),
    p("neonsign", 2, 0, "sw"),
    p("lavalamp", 3, 0, "se"),
    p("monstera", 1, 9, "se", 1),
  ],
} as const;

/** A row partition (axis `row` at 4, facing sw); the doorway is the walkable tunnel at (3, 4). */
export const REEF = {
  shell: "reef",
  furniture: [
    p("partition", 0, 4, "sw", 2),
    ...[1, 2, 4, 5, 6, 7, 8].map((col) => p("partition", col, 4, "sw", TANK)),
    p("partition", 3, 4, "sw", TUNNEL),
    p("partition", 9, 4, "sw", 2),
    // The reef bar, rows 5–9.
    p("barcounter", 0, 5, "se"),
    p("stool", 1, 5, "nw", 1),
    p("stool", 1, 6, "nw", 1),
    p("wallscreen", 0, 7, "se"),
    p("couch", 4, 7, "nw"),
    p("coffeetable", 2, 8, "se"),
    p("neonsign", 0, 9, "se", 1),
    p("lavalamp", 8, 6, "se", 1),
    p("monstera", 9, 8, "se", 1),
    // The deep, rows 0–3.
    p("hammock", 5, 1, "sw"),
    p("beanbag", 2, 2, "sw", 1),
    p("beanbag", 8, 2, "sw", 1),
    p("lavalamp", 0, 0, "se", 1),
    p("lavalamp", 9, 0, "se", 1),
    p("monstera", 0, 2, "se", 1),
  ],
} as const;
