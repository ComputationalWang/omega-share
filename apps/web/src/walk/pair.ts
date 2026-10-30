// The Dank Dungeon pair's frame keys (OME-1672, assets/avatars/dungeon.json): `bendover/<avatar>/<se|sw>/0` and
// `thrust/<avatar>/<se|sw>/<0-2>`, built once so a frame draw allocates nothing.
import { AVATAR_IDS } from "./avatar-ids";

/** How long the pair plays before both go back to idle. */
export const PAIR_MS = 4000;
/** The thrust loop: frames 0 1 2 1 at this many ms each (dungeon.json `meta.omega.thrust`). */
export const THRUST_FRAME_MS = 110;
export const THRUST_SEQUENCE: readonly number[] = [0, 1, 2, 1];
/** How far back the thruster stands from the bender's floor point, away from their facing (OME-1970): x mirrors per front. */
export const THRUST_BACK = { x: 4, y: 2 } as const;

export interface PairKeys {
  readonly bend: string;
  readonly thrust: readonly string[];
}

const FRONT = ["se", "sw"] as const;
/** keys[avatar][0 = se, 1 = sw]. */
const KEYS: readonly (readonly PairKeys[])[] = AVATAR_IDS.map((id) => FRONT.map((d) => ({ bend: `bendover/${id}/${d}/0`, thrust: [0, 1, 2].map((n) => `thrust/${id}/${d}/${String(n)}`) })));

/** Front views only: a back-facing (ne, nw) bender is turned to the front on the side they already lean. */
export const frontIndex = (dir: string): 0 | 1 => (dir === "se" || dir === "ne" ? 0 : 1);

export const pairKeys = (avatar: number, front: 0 | 1): PairKeys | undefined => KEYS[avatar]?.[front];

/** A frame of the dungeon sheet (not the motion sheets). */
export const isPairFrame = (frame: string): boolean => frame.startsWith("thrust/") || frame.startsWith("bendover/");
