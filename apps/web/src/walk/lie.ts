// The lying pose's frame keys and where it sits on a piece (OME-1691, assets/avatars/lying.json): `lie/<avatar>/<dir>/<0|1>`
// on a sofa or couch, `curl/<avatar>/<se|sw>/<0|1>` in the cat bed. Built once so a frame draw allocates nothing.
// No JSON imports: e2e specs load animator → this under Node (walk-lie.test.ts pins every table to lying.json).
import { FURNITURE, layoutSeats, type FurnitureKind, type LieStyle, type RoomLayout } from "@omega/shared";
import type { Point } from "../layout";
import { AVATAR_IDS } from "./avatar-ids";
import type { Dir } from "./walks";

/** The breath: frame 0 for 1400 ms, frame 1 for 1000 ms (lying.json `meta.omega.anims`). */
export const LIE_MS: readonly number[] = [1400, 1000];

const DIRS: readonly Dir[] = ["se", "sw", "ne", "nw"];
/** keys[style][avatar][dir index]; the cat bed's art has se and sw only. */
const KEYS: Readonly<Record<LieStyle, readonly (readonly ([string, string] | undefined)[])[]>> = {
  lie: AVATAR_IDS.map((id) => DIRS.map((d) => [`lie/${id}/${d}/0`, `lie/${id}/${d}/1`])),
  curl: AVATAR_IDS.map((id) => DIRS.map((d) => (d === "se" || d === "sw" ? [`curl/${id}/${d}/0`, `curl/${id}/${d}/1`] : undefined))),
  sleep: AVATAR_IDS.map((id) => DIRS.map((d) => [`sleep/${id}/${d}/0`, `sleep/${id}/${d}/1`])),
};

export const lieKeys = (style: LieStyle, avatar: number, dir: Dir): readonly [string, string] | undefined => KEYS[style][avatar]?.[DIRS.indexOf(dir)];

const SOFA: Readonly<Partial<Record<Dir, Point>>> = { se: { x: -4, y: 4 }, sw: { x: 4, y: 4 }, ne: { x: 4, y: 1 }, nw: { x: -4, y: 1 } };
const OFFSETS: Readonly<Partial<Record<FurnitureKind, Readonly<Partial<Record<Dir, Point>>>>>> = {
  sofa: SOFA,
  couch: SOFA,
  cat: { se: { x: 12, y: -2 }, sw: { x: -12, y: -2 } },
  // The bed (`sleep`, OME-2008) has no entry yet: its two sleepers' offsets come with the web sleeper issue (OME-1984).
  // shortcut: the v7 lounger (`lie: "lie"`) has no entry, so no lie spot: lying.json has no lounger art yet; it seats only. Add its offsets with the art.
};

/** Screen px from the piece's anchor to the lier's floor point (lying.json `meta.omega.pieces`); none for a facing the art lacks. */
export const lieOffset = (kind: FurnitureKind, dir: Dir): Point | undefined => OFFSETS[kind]?.[dir];

/** A frame of the lying sheet (not the motion sheets). */
export const isLieFrame = (frame: string): boolean => frame.startsWith("lie/") || frame.startsWith("curl/") || frame.startsWith("sleep/");

/** How someone can lie on layout piece `piece`, or undefined if there is no such piece or it has no lie style. */
export const lieStyleOf = (layout: RoomLayout, piece: number): LieStyle | undefined => {
  const f = layout.furniture[piece];
  return f === undefined ? undefined : FURNITURE[f.kind].lie;
};

/** The seat indices layout piece `piece` gives, [first, end); the twin of server-rs `piece_seats` (seats count in layout order). */
export const pieceSeats = (layout: RoomLayout, piece: number): readonly [number, number] => {
  let first = 0;
  for (let i = 0; i < piece && i < layout.furniture.length; i++) {
    const f = layout.furniture[i];
    if (f !== undefined) first += layoutSeats({ furniture: [f] }).length;
  }
  const f = layout.furniture[piece];
  return [first, f === undefined ? first : first + layoutSeats({ furniture: [f] }).length];
};
