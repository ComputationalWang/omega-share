// The lying pose's frame keys and where it sits on a piece (OME-1691, assets/avatars/lying.json): `lie/<avatar>/<dir>/<0|1>`
// on a sofa or couch, `curl/<avatar>/<se|sw>/<0|1>` in the cat bed. Built once so a frame draw allocates nothing.
import type { FurnitureKind, LieStyle } from "@omega/shared";
import type { Point } from "../layout";
import type { Dir } from "./walks";

/** The breath: frame 0 for 1400 ms, frame 1 for 1000 ms (lying.json `meta.omega.anims`). */
export const LIE_MS: readonly number[] = [1400, 1000];

export const lieKeys = (_style: LieStyle, _avatar: number, _dir: Dir): readonly [string, string] | undefined => undefined;

/** Screen px from the piece's anchor to the lier's floor point (lying.json `meta.omega.pieces`); none for a facing the art lacks. */
export const lieOffset = (_kind: FurnitureKind, _dir: Dir): Point | undefined => undefined;

/** A frame of the lying sheet (not the motion sheets). */
export const isLieFrame = (_frame: string): boolean => false;
