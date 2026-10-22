// What a footstep lands on (OME-1638): the room's floor is wood, rugs and runners are carpet, a teleport pad is tile.
import { FLOOR_CELLS, footprintCells } from "@omega/shared";

export type FloorKind = "wood" | "carpet" | "tile";
type Placed = Parameters<typeof footprintCells>[0];

const UNDERFOOT: Partial<Record<Placed["kind"], FloorKind>> = { rug: "carpet", runner: "carpet", pad: "tile" };

/** The floor kind of each cell (`col * FLOOR_CELLS + row`, path.ts) for a layout's furniture; wood off the floor. */
export function floorKinds(furniture: readonly Placed[]): (cell: number) => FloorKind {
  const kinds: FloorKind[] = Array.from({ length: FLOOR_CELLS * FLOOR_CELLS }, () => "wood");
  for (const f of furniture) {
    const kind = UNDERFOOT[f.kind];
    if (kind === undefined) continue;
    for (const [c, r] of footprintCells(f)) if (c < FLOOR_CELLS && r < FLOOR_CELLS) kinds[c * FLOOR_CELLS + r] = kind;
  }
  return (cell) => kinds[cell] ?? "wood";
}
